import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ATTR } from '@/utils/telemetry/attributes';
import { METRIC } from '@/utils/telemetry/metrics';

const dashboardPath = resolve(__dirname, '../../../tools/otel/dashboards/haramblock-dvr.json');
const dashboard = JSON.parse(readFileSync(dashboardPath, 'utf8')) as { panels: Panel[] };

const BACKGROUND_METRICS = ['hb.inference.run.duration', 'hb.inference.requests'];
const KNOWN_DATASOURCES = ['prometheus', 'loki', 'tempo'];

const toPrometheusName = (otelName: string): string => otelName.replaceAll('.', '_');

const knownPrometheusMetrics = [...Object.values(METRIC), ...BACKGROUND_METRICS].map(toPrometheusName);
const knownPrometheusLabels = Object.values(ATTR).map(toPrometheusName);

interface Target {
  datasource?: { uid?: string };
  expr?: string;
}

interface Panel {
  id: number;
  title: string;
  datasource?: { uid?: string };
  targets?: Target[];
  panels?: Panel[];
}

const flattenPanels = (panels: Panel[]): Panel[] =>
  panels.flatMap(panel => [panel, ...flattenPanels(panel.panels ?? [])]);

const panels = flattenPanels(dashboard.panels);
const prometheusTargets = panels
  .flatMap(panel => panel.targets ?? [])
  .filter(target => target.datasource?.uid === 'prometheus' && target.expr);
const exprs = prometheusTargets.map(target => target.expr as string);

const metricReferences = (expr: string): string[] => {
  const withoutLabels = expr.replaceAll(/\{[^}]*\}/g, '').replaceAll(/\bby \([^)]*\)/g, '');
  return [...withoutLabels.matchAll(/\bhb_[a-z0-9_]+/g)].map(match => match[0]);
};

const stripPrometheusSuffix = (name: string): string =>
  name.replace(/_(bucket|count|sum|total)$/, '').replace(/_milliseconds$/, '');

const labelReferences = (expr: string): string[] => [
  ...[...expr.matchAll(/\b(hb_[a-z0-9_]+)\s*(?:=~?|!=|!~)/g)].map(match => match[1] ?? ''),
  ...[...expr.matchAll(/\bby \(([^)]*)\)/g)].flatMap(match => (match[1] ?? '').match(/hb_[a-z0-9_]+/g) ?? []),
];

describe('haramblock-dvr dashboard', () => {
  it('has unique panel ids', () => {
    const ids = panels.map(panel => panel.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only references provisioned datasources', () => {
    const uids = [
      ...panels.map(panel => panel.datasource?.uid),
      ...panels.flatMap(p => (p.targets ?? []).map(t => t.datasource?.uid)),
    ].filter((uid): uid is string => uid !== undefined);
    expect(uids.length).toBeGreaterThan(0);
    for (const uid of uids) expect(KNOWN_DATASOURCES).toContain(uid);
  });

  it('only queries metrics declared in METRIC or the background meter', () => {
    expect(exprs.length).toBeGreaterThan(0);
    for (const expr of exprs) {
      for (const reference of metricReferences(expr)) {
        expect(knownPrometheusMetrics, `${reference} in ${expr}`).toContain(stripPrometheusSuffix(reference));
      }
    }
  });

  it('only filters on labels declared in ATTR', () => {
    for (const expr of exprs) {
      for (const label of labelReferences(expr)) {
        expect(knownPrometheusLabels, `${label} in ${expr}`).toContain(label);
      }
    }
  });

  it('covers every DVR metric', () => {
    const referenced = new Set(exprs.flatMap(metricReferences).map(stripPrometheusSuffix));
    for (const name of Object.values(METRIC)) expect([...referenced], name).toContain(toPrometheusName(name));
  });

  it('has a Loki anomaly panel and a Tempo trace panel', () => {
    const lokiTargets = panels.flatMap(p => p.targets ?? []).filter(t => t.datasource?.uid === 'loki');
    const tempoTargets = panels.flatMap(p => p.targets ?? []).filter(t => t.datasource?.uid === 'tempo');
    expect(lokiTargets.some(t => /video.*dvr.*anomaly/.test(t.expr ?? ''))).toBe(true);
    expect(tempoTargets.length).toBeGreaterThan(0);
  });
});
