import {SignalRef} from 'vega';
import {selector as parseSelector} from 'vega-event-selector';
import {identity, isArray, stringValue} from 'vega-util';
import {forEachSelection, LEGEND, MODIFY, SELECTION_DOMAIN, STORE, TUPLE, unitName, VL_SELECTION_RESOLVE} from '.';
import {dateTimeExpr, isDateTime} from '../../datetime';
import {warn} from '../../log';
import {LogicalOperand} from '../../logical';
import {SelectionInit, SelectionInitArray} from '../../selection';
import {accessPathWithDatum, keys, logicalExpr, varName} from '../../util';
import {VgData} from '../../vega.schema';
import {DataFlowNode} from '../data/dataflow';
import {FacetModel} from '../facet';
import {LayerModel} from '../layer';
import {InteractiveSelections} from '../legend/component';
import {interactiveLegendExists} from '../legend/parse';
import {isUnitModel, Model} from '../model';
import {UnitModel} from '../unit';
import {forEachTransform} from './transforms/transforms';

export function assembleInit(
  init: (SelectionInit | SelectionInit[] | SelectionInitArray)[] | SelectionInit,
  wrap: (str: string) => string = identity
): string {
  if (isArray(init)) {
    const str = init.map(v => assembleInit(v, wrap)).join(', ');
    return `[${str}]`;
  } else if (isDateTime(init)) {
    return wrap(dateTimeExpr(init));
  }
  return wrap(JSON.stringify(init));
}
export function assembleUnitSelectionSignals(model: UnitModel, signals: any[]) {
  forEachSelection(model, (selCmpt, selCompiler) => {
    const name = selCmpt.name;
    let modifyExpr = selCompiler.modifyExpr(model, selCmpt);

    signals.push(...selCompiler.signals(model, selCmpt));

    forEachTransform(selCmpt, txCompiler => {
      if (txCompiler.signals) {
        signals = txCompiler.signals(model, selCmpt, signals);
      }
      if (txCompiler.modifyExpr) {
        modifyExpr = txCompiler.modifyExpr(model, selCmpt, modifyExpr);
      }
    });

    signals.push({
      name: name + MODIFY,
      update: `modify(${stringValue(selCmpt.name + STORE)}, ${modifyExpr})`
    });
  });

  const selections = interactiveLegendExists(model);
  if (selections.length) {
    return assembleInteractiveLegendSignals(model, signals, selections);
  }

  return signals;
}

function assembleInteractiveLegendSignals(
  model: UnitModel,
  signals: any[],
  selections: InteractiveSelections[]
): any[] {
  const datum = '(item().isVoronoi ? datum.datum : datum)';
  let selectionFields: string[] = [].concat.apply([], selections.map(s => s.fields)); // Flatten array
  selectionFields = selectionFields.filter((v, i, a) => a.indexOf(v) === i); // Get unique elements

  selections.forEach(selection => {
    const name = selection.name;
    const signal = signals.filter(s => s.name === name + TUPLE)[0];

    const ignoreLegendExpression = selectionFields.reduce((exp, field) => {
      return `item().mark.name !== 'symbols_${field}${LEGEND}' && item().mark.name !== 'labels_${field}${LEGEND}' && ${exp}`;
    }, '');

    signal.on[0].update = ignoreLegendExpression + signal.on[0].update;

    const eventExpression = selection.fields.reduce((expression, field) => {
      return `@symbols_${field}${LEGEND}:click, @labels_${field}${LEGEND}:click, ${expression}`;
    }, '');

    if (selection.fields.length !== 1) {
      const fieldSignals = selection.fields.map(field => {
        signals.unshift({
          name: `${name}_${field}_legend`,
          on: [
            {
              events: [{source: 'scope', type: 'click'}],
              // update: `${ignoreLegendExpression} item().mark.marktype !== 'group' ? (item().mark.marktype === 'group' ? ${name}_${field}_legend : ${datum}['${field}']) : null`
              update: `${ignoreLegendExpression} item().mark.marktype !== 'group' ? ${datum}['${field}'] : (!(${ignoreLegendExpression.slice(
                0,
                -4
              )}) ? ${name}_${field}_legend : null)`
            },
            {
              events: `@symbols_${field}${LEGEND}:click, @labels_${field}${LEGEND}:click`,
              update: `datum.value`
            }
          ]
        });
        return `${name}_${field}_legend`;
      });
      signal.on.push({
        events: eventExpression,
        update: `${fieldSignals.join(' && ')} ? {unit: ${unitName(
          model
        )}, fields: ${name}_tuple_fields, values: [ ${fieldSignals.join(',')} ]} : ${signal.name}`
      });

      const toggleSignal = signals.filter(s => s.name === name + '_toggle')[0];
      toggleSignal.on[0].update = `${ignoreLegendExpression.slice(0, -4)} ? event.shiftKey : false`;
    } else {
      signal.on.push({
        events: eventExpression,
        update: `{unit: ${unitName(model)}, fields: ${name}_tuple_fields, values: [datum.value]}`
      });
    }
  });

  return signals;
}

export function assembleFacetSignals(model: FacetModel, signals: any[]) {
  if (model.component.selection && keys(model.component.selection).length) {
    const name = stringValue(model.getName('cell'));
    signals.unshift({
      name: 'facet',
      value: {},
      on: [
        {
          events: parseSelector('mousemove', 'scope'),
          update: `isTuple(facet) ? facet : group(${name}).datum`
        }
      ]
    });
  }

  return signals;
}

export function assembleTopLevelSignals(model: UnitModel, signals: any[]) {
  let hasSelections = false;
  forEachSelection(model, (selCmpt, selCompiler) => {
    const name = selCmpt.name;
    const store = stringValue(name + STORE);
    const hasSg = signals.filter(s => s.name === name);
    if (!hasSg.length) {
      signals.push({
        name: selCmpt.name,
        update:
          `${VL_SELECTION_RESOLVE}(${store}` +
          (selCmpt.resolve === 'global' ? ')' : `, ${stringValue(selCmpt.resolve)})`)
      });
    }
    hasSelections = true;

    if (selCompiler.topLevelSignals) {
      signals = selCompiler.topLevelSignals(model, selCmpt, signals);
    }

    forEachTransform(selCmpt, txCompiler => {
      if (txCompiler.topLevelSignals) {
        signals = txCompiler.topLevelSignals(model, selCmpt, signals);
      }
    });
  });

  if (hasSelections) {
    const hasUnit = signals.filter(s => s.name === 'unit');
    if (!hasUnit.length) {
      signals.unshift({
        name: 'unit',
        value: {},
        on: [{events: 'mousemove', update: 'isTuple(group()) ? group() : unit'}]
      });
    }
  }

  return signals;
}

export function assembleUnitSelectionData(model: UnitModel, data: VgData[]): VgData[] {
  forEachSelection(model, selCmpt => {
    const contains = data.filter(d => d.name === selCmpt.name + STORE);
    if (!contains.length) {
      data.push({name: selCmpt.name + STORE});
    }
  });

  return data;
}

export function assembleUnitSelectionMarks(model: UnitModel, marks: any[]): any[] {
  forEachSelection(model, (selCmpt, selCompiler) => {
    marks = selCompiler.marks ? selCompiler.marks(model, selCmpt, marks) : marks;
    forEachTransform(selCmpt, txCompiler => {
      if (txCompiler.marks) {
        marks = txCompiler.marks(model, selCmpt, marks);
      }
    });
  });

  return marks;
}

export function assembleLayerSelectionMarks(model: LayerModel, marks: any[]): any[] {
  for (const child of model.children) {
    if (isUnitModel(child)) {
      marks = assembleUnitSelectionMarks(child, marks);
    }
  }

  return marks;
}

export function assembleSelectionPredicate(
  model: Model,
  selections: LogicalOperand<string>,
  dfnode?: DataFlowNode
): string {
  const stores: string[] = [];
  function expr(name: string): string {
    const vname = varName(name);
    const selCmpt = model.getSelectionComponent(vname, name);
    const store = stringValue(vname + STORE);

    if (selCmpt.project.timeUnit) {
      const child = dfnode || model.component.data.raw;
      const tunode = selCmpt.project.timeUnit.clone();
      if (child.parent) {
        tunode.insertAsParentOf(child);
      } else {
        child.parent = tunode;
      }
    }

    if (selCmpt.empty !== 'none') {
      stores.push(store);
    }

    return (
      `vlSelectionTest(${store}, datum` + (selCmpt.resolve === 'global' ? ')' : `, ${stringValue(selCmpt.resolve)})`)
    );
  }

  const predicateStr = logicalExpr(selections, expr);
  return (
    (stores.length ? '!(' + stores.map(s => `length(data(${s}))`).join(' || ') + ') || ' : '') + `(${predicateStr})`
  );
}

// Selections are parsed _after_ scales. If a scale domain is set to
// use a selection, the SELECTION_DOMAIN constant is used as the
// domainRaw.signal during scale.parse and then replaced with the necessary
// selection expression function during scale.assemble. To not pollute the
// type signatures to account for this setup, the selection domain definition
// is coerced to a string and appended to SELECTION_DOMAIN.
export function assembleSelectionScaleDomain(model: Model, domainRaw: SignalRef): SignalRef {
  const selDomain = JSON.parse(domainRaw.signal.replace(SELECTION_DOMAIN, ''));
  const name = varName(selDomain.selection);
  const encoding = selDomain.encoding;
  let field = selDomain.field;

  let selCmpt = model.component.selection && model.component.selection[name];
  if (selCmpt) {
    warn('Use "bind": "scales" to setup a binding for scales and selections within the same view.');
  } else {
    selCmpt = model.getSelectionComponent(name, selDomain.selection);
    if (!encoding && !field) {
      field = selCmpt.project[0].field;
      if (selCmpt.project.length > 1) {
        warn(
          'A "field" or "encoding" must be specified when using a selection as a scale domain. ' +
            `Using "field": ${stringValue(field)}.`
        );
      }
    } else if (encoding && !field) {
      const encodings = selCmpt.project.filter(p => p.channel === encoding);
      if (!encodings.length || encodings.length > 1) {
        field = selCmpt.project[0].field;
        warn(
          (!encodings.length ? 'No ' : 'Multiple ') +
            `matching ${stringValue(encoding)} encoding found for selection ${stringValue(selDomain.selection)}. ` +
            `Using "field": ${stringValue(field)}.`
        );
      } else {
        field = encodings[0].field;
      }
    }

    return {signal: accessPathWithDatum(field, name)};
  }

  return {signal: 'null'};
}
