import { afterEach, describe, expect, it, vi } from 'vitest';

import { cacheModelIdOf, discoverModels, type ModelDefinition } from '@/utils/inference/shared/modelRegistry';

const metadataYaml = (id: string, rank?: number) =>
  [`id: ${id}`, `name: ${id}`, 'imgsz:', '- 320', '- 320', ...(rank === undefined ? [] : [`rank: ${rank}`])].join('\n');

function serveMetadata(byPath: Record<string, string>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(input => {
    const url = typeof input === 'string' ? input : '';
    const body = byPath[url.replace('/metadata.yaml', '')];
    return Promise.resolve(new Response(body ?? '', { status: body ? 200 : 404 }));
  });
}

describe('model discovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('versions each model by its folder date suffix and ranks it as its metadata declares', async () => {
    serveMetadata({ '/models/afeef-y26-sem-320-20261001': metadataYaml('sem-i320', 4) });
    const models = new Map<string, ModelDefinition>();
    await discoverModels(['/models/afeef-y26-sem-320-20261001'], models);

    const model = models.get('sem-i320') ?? { id: 'missing', version: 'missing' };
    expect(model).toMatchObject({ version: '20261001', rank: 4 });
    expect(cacheModelIdOf(model)).toBe('sem-i320@20261001');
  });

  it('ranks a model whose metadata declares no rank lowest', async () => {
    serveMetadata({ '/models/sem-320-20260607': metadataYaml('sem-i320') });
    const models = new Map<string, ModelDefinition>();
    await discoverModels(['/models/sem-320-20260607'], models);

    expect(models.get('sem-i320')?.rank).toBe(0);
  });
});
