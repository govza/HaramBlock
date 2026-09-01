import { metrics, trace, type Meter, type Tracer } from '@opentelemetry/api';

export function getTracer(scope: string): Tracer {
  return trace.getTracer(scope);
}

export function getMeter(scope: string): Meter {
  return metrics.getMeter(scope);
}
