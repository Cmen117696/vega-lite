import {Legend as VgLegend, LegendEncode, SignalRef} from 'vega';
import {stringValue} from 'vega-util';
import {
  COLOR,
  FILL,
  FILLOPACITY,
  NonPositionScaleChannel,
  OPACITY,
  SHAPE,
  SIZE,
  STROKE,
  STROKEOPACITY,
  STROKEWIDTH
} from '../../channel';
import {getTypedFieldDef, isFieldDef, title as fieldDefTitle, TypedFieldDef} from '../../fielddef';
import {Legend, LEGEND_PROPERTIES, VG_LEGEND_PROPERTIES} from '../../legend';
import {GEOJSON} from '../../type';
import {deleteNestedProperty, getFirstDefined, keys} from '../../util';
import {mergeTitleComponent, numberFormat} from '../common';
import {guideEncodeEntry} from '../guide';
import {isUnitModel, Model} from '../model';
import {parseGuideResolve} from '../resolve';
import {forEachSelection, LEGEND, STORE, VL_SELECTION_TEST} from '../selection';
import {defaultTieBreaker, Explicit, makeImplicit, mergeValuesWithExplicit} from '../split';
import {UnitModel} from '../unit';
import {InteractiveSelections, LegendComponent, LegendComponentIndex} from './component';
import * as encode from './encode';
import * as properties from './properties';
import {direction, type} from './properties';

export function parseLegend(model: Model) {
  if (isUnitModel(model)) {
    model.component.legends = parseUnitLegend(model);
  } else {
    model.component.legends = parseNonUnitLegend(model);
  }
}

function parseUnitLegend(model: UnitModel): LegendComponentIndex {
  const {encoding} = model;
  return [COLOR, FILL, STROKE, STROKEWIDTH, SIZE, SHAPE, OPACITY, FILLOPACITY, STROKEOPACITY].reduce(
    (legendComponent, channel) => {
      const def = encoding[channel];
      if (
        model.legend(channel) &&
        model.getScaleComponent(channel) &&
        !(isFieldDef(def) && (channel === SHAPE && def.type === GEOJSON))
      ) {
        legendComponent[channel] = parseLegendForChannel(model, channel);
      }
      return legendComponent;
    },
    {}
  );
}

function getLegendDefWithScale(model: UnitModel, channel: NonPositionScaleChannel): VgLegend {
  const scale = model.scaleName(COLOR);
  if (channel === 'color') {
    return model.markDef.filled ? {fill: scale} : {stroke: scale};
  }
  return {[channel]: model.scaleName(channel)};
}

function isExplicit<T extends string | number | object | boolean>(
  value: T,
  property: keyof VgLegend,
  legend: Legend,
  fieldDef: TypedFieldDef<string>
) {
  switch (property) {
    case 'values':
      // specified legend.values is already respected, but may get transformed.
      return !!legend.values;
    case 'title':
      // title can be explicit if fieldDef.title is set
      if (property === 'title' && value === fieldDef.title) {
        return true;
      }
  }
  // Otherwise, things are explicit if the returned value matches the specified property
  return value === legend[property];
}

export function parseLegendForChannel(model: UnitModel, channel: NonPositionScaleChannel): LegendComponent {
  const fieldDef = model.fieldDef(channel);
  const legend = model.legend(channel);

  const legendCmpt = new LegendComponent({}, getLegendDefWithScale(model, channel));

  for (const property of LEGEND_PROPERTIES) {
    const value = getProperty(property, legend, channel, model);
    if (value !== undefined) {
      const explicit = isExplicit(value, property, legend, fieldDef);
      if (explicit || model.config.legend[property] === undefined) {
        legendCmpt.set(property, value, explicit);
      }
    }
  }

  const legendEncoding = legend.encoding || {};
  let legendEncode = ['labels', 'legend', 'title', 'symbols', 'gradient'].reduce(
    (e: LegendEncode, part) => {
      const legendEncodingPart = guideEncodeEntry(legendEncoding[part] || {}, model);
      const value = encode[part]
        ? encode[part](fieldDef, legendEncodingPart, model, channel, legendCmpt) // apply rule
        : legendEncodingPart; // no rule -- just default values
      if (value !== undefined && keys(value).length > 0) {
        e[part] = {update: value};
      }
      return e;
    },
    {} as LegendEncode
  );

  const interactiveSelections = interactiveLegendExists(model);
  if (interactiveSelections.length) {
    legendEncode = updateInteractiveLegendComponent(model, legendEncode, channel, interactiveSelections);
  }
  if (keys(legendEncode).length > 0) {
    legendCmpt.set('encode', legendEncode, !!legend.encoding);
  }

  return legendCmpt;
}

export function interactiveLegendExists(model: UnitModel) {
  if (model.parent) {
    return [];
  }
  const selections: InteractiveSelections[] = [];
  // Look over all selections
  forEachSelection(model, selCmpt => {
    if (selCmpt['fields']) {
      selections.push({name: selCmpt.name, store: stringValue(selCmpt.name + STORE), fields: selCmpt['fields']});
    }
  });

  // Quit if no selections have projections
  if (!selections.length) {
    return [];
  }

  // Encoding channels should fully populate selections
  let selectionFields: string[] = [].concat.apply([], selections.map(s => s.fields)); // Flatten array
  selectionFields = selectionFields.filter((v, i, a) => a.indexOf(v) === i); // Get unique elements

  let encodingFields: string[] = [];
  [COLOR, OPACITY, SIZE, SHAPE].forEach(channel => {
    const fieldDef = model.fieldDef(channel);
    if (
      fieldDef &&
      !(fieldDef.hasOwnProperty('bin') || fieldDef.hasOwnProperty('aggregate') || fieldDef.hasOwnProperty('timeUnit'))
    ) {
      encodingFields.push(fieldDef.field);
    }
  });

  encodingFields = encodingFields.filter((v, i, a) => a.indexOf(v) === i); // Get unique elements
  const differenceFields = selectionFields.filter(x => encodingFields.indexOf(x) === -1);
  if (differenceFields.length) {
    return [];
  }
  return selections;
}

function updateInteractiveLegendComponent(
  model: UnitModel,
  legendEncode: LegendEncode,
  channel: NonPositionScaleChannel,
  interactiveSelections: InteractiveSelections[]
): LegendEncode {
  switch (channel) {
    case COLOR:
    case OPACITY:
    case SIZE:
    case SHAPE:
      break;
    default:
      return legendEncode;
  }
  const field = model.fieldDef(channel).field;

  // Choose the selection with highest specifictiy of projection containing the field
  let selectionIndex: number;
  let maxFields = 0;
  interactiveSelections.forEach((s, i) => {
    if (s.fields.length > maxFields && s.fields.indexOf(field) > -1) {
      maxFields = s.fields.length;
      selectionIndex = i;
    }
  });
  if (!maxFields) {
    return legendEncode;
  }
  const maxProjSelection = interactiveSelections[selectionIndex];

  const updatedLegendEncode = legendEncode;
  let updateValue;
  ['labels', 'symbols'].forEach(part => {
    if (updatedLegendEncode.hasOwnProperty(part)) {
      updateValue = updatedLegendEncode[part].update;
    } else {
      updateValue = {opacity: {value: 0.7}};
    }

    let test = `!(length(data(${maxProjSelection.store}))) || ${VL_SELECTION_TEST}(${
      maxProjSelection.store
    }, {${field}: datum.value})`;
    if (maxProjSelection.fields.length > 1) {
      test = `!${maxProjSelection.name}_${field}_legend || datum.value === ${maxProjSelection.name}_${field}_legend`;
    }
    if (part === 'symbols' && channel === OPACITY) {
      let strokeValue = '#000000';
      if (updateValue.stroke) {
        strokeValue = updateValue.stroke.value;
      }
      updateValue.stroke = [{test, value: strokeValue}, {value: '#aaaaaa'}];
    } else {
      let opacityValue = 0.7;
      if (updateValue.opacity) {
        opacityValue = updateValue.opacity.value;
      }
      updateValue.opacity = [{test, value: opacityValue}, {value: 0.2}];
    }

    updatedLegendEncode[part] = {name: `${part}_${field}${LEGEND}`, interactive: true, update: updateValue};
  });
  return updatedLegendEncode;
}

function getProperty<K extends keyof VgLegend>(
  property: K,
  legend: Legend,
  channel: NonPositionScaleChannel,
  model: UnitModel
): VgLegend[K] {
  const {encoding, mark} = model;
  const fieldDef = getTypedFieldDef(encoding[channel]);
  const legendConfig = model.config.legend;
  const {timeUnit} = fieldDef;

  const scaleType = model.getScaleComponent(channel).get('type');

  switch (property) {
    case 'format':
      // We don't include temporal field here as we apply format in encode block
      return numberFormat(fieldDef, legend.format, model.config);
    case 'title':
      return fieldDefTitle(fieldDef, model.config, {allowDisabling: true}) || undefined;

    case 'type':
      return type({legend, channel, timeUnit, scaleType, alwaysReturn: false});

    case 'direction':
      return direction({legend, legendConfig, timeUnit, channel, scaleType});

    // TODO: enable when https://github.com/vega/vega/issues/1351 is fixed
    // case 'clipHeight':
    //   return getFirstDefined(specifiedLegend.clipHeight, properties.clipHeight(properties.type(...)));
    case 'labelOverlap':
      return getFirstDefined(legend.labelOverlap, properties.defaultLabelOverlap(scaleType));
    case 'gradientLength':
      return getFirstDefined<number | SignalRef>(
        // do specified gradientLength first
        legend.gradientLength,
        legendConfig.gradientLength,
        // Otherwise, use smart default based on plot height
        properties.defaultGradientLength({
          model,
          legend,
          legendConfig,
          channel,
          scaleType
        })
      );

    case 'symbolType':
      return getFirstDefined(legend.symbolType, properties.defaultSymbolType(mark));

    case 'values':
      return properties.values(legend, fieldDef);
  }

  // Otherwise, return specified property.
  return (legend as VgLegend)[property];
}

function parseNonUnitLegend(model: Model) {
  const {legends, resolve} = model.component;

  for (const child of model.children) {
    parseLegend(child);

    keys(child.component.legends).forEach((channel: NonPositionScaleChannel) => {
      resolve.legend[channel] = parseGuideResolve(model.component.resolve, channel);

      if (resolve.legend[channel] === 'shared') {
        // If the resolve says shared (and has not been overridden)
        // We will try to merge and see if there is a conflict

        legends[channel] = mergeLegendComponent(legends[channel], child.component.legends[channel]);

        if (!legends[channel]) {
          // If merge returns nothing, there is a conflict so we cannot make the legend shared.
          // Thus, mark legend as independent and remove the legend component.
          resolve.legend[channel] = 'independent';
          delete legends[channel];
        }
      }
    });
  }

  keys(legends).forEach((channel: NonPositionScaleChannel) => {
    for (const child of model.children) {
      if (!child.component.legends[channel]) {
        // skip if the child does not have a particular legend
        continue;
      }

      if (resolve.legend[channel] === 'shared') {
        // After merging shared legend, make sure to remove legend from child
        delete child.component.legends[channel];
      }
    }
  });
  return legends;
}

export function mergeLegendComponent(mergedLegend: LegendComponent, childLegend: LegendComponent): LegendComponent {
  if (!mergedLegend) {
    return childLegend.clone();
  }
  const mergedOrient = mergedLegend.getWithExplicit('orient');
  const childOrient = childLegend.getWithExplicit('orient');

  if (mergedOrient.explicit && childOrient.explicit && mergedOrient.value !== childOrient.value) {
    // TODO: throw warning if resolve is explicit (We don't have info about explicit/implicit resolve yet.)
    // Cannot merge due to inconsistent orient
    return undefined;
  }

  let typeMerged = false;
  // Otherwise, let's merge
  for (const prop of VG_LEGEND_PROPERTIES) {
    const mergedValueWithExplicit = mergeValuesWithExplicit<VgLegend, any>(
      mergedLegend.getWithExplicit(prop),
      childLegend.getWithExplicit(prop),
      prop,
      'legend',

      // Tie breaker function
      (v1: Explicit<any>, v2: Explicit<any>): any => {
        switch (prop) {
          case 'symbolType':
            return mergeSymbolType(v1, v2);
          case 'title':
            return mergeTitleComponent(v1, v2);
          case 'type':
            // There are only two types. If we have different types, then prefer symbol over gradient.
            typeMerged = true;
            return makeImplicit('symbol');
        }
        return defaultTieBreaker<VgLegend, any>(v1, v2, prop, 'legend');
      }
    );
    mergedLegend.setWithExplicit(prop, mergedValueWithExplicit);
  }
  if (typeMerged) {
    if (((mergedLegend.implicit || {}).encode || {}).gradient) {
      deleteNestedProperty(mergedLegend.implicit, ['encode', 'gradient']);
    }
    if (((mergedLegend.explicit || {}).encode || {}).gradient) {
      deleteNestedProperty(mergedLegend.explicit, ['encode', 'gradient']);
    }
  }

  return mergedLegend;
}

function mergeSymbolType(st1: Explicit<string>, st2: Explicit<string>) {
  if (st2.value === 'circle') {
    // prefer "circle" over "stroke"
    return st2;
  }
  return st1;
}
