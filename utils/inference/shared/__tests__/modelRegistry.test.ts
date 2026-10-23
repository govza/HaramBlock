import { afterEach, describe, expect, it, vi } from 'vitest';

import { cacheModelIdOf, discoverModels, type ModelDefinition } from '@/utils/inference/shared/modelRegistry';

const metadataYaml = (id: string) =>
  [
    `id: ${id}`,
    `name: ${id}`,
    'task: semantic',
    'imgsz:',
    '- 320',
    '- 320',
    'names:',
    '  0: background',
    '  1: aurat_male',
    '  2: aurat_female',
    '  3: safe_person',
  ].join('\n');

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

  it('versions each model by its folder date suffix and keys compatibility by task and masked classes', async () => {
    serveMetadata({ '/models/afeef-y26-sem-320-20261001': metadataYaml('sem-i320') });
    const models = new Map<string, ModelDefinition>();
    await discoverModels(['/models/afeef-y26-sem-320-20261001'], models);

    const model = models.get('sem-i320') ?? { id: 'missing', version: 'missing' };
    expect(model).toMatchObject({ version: '20261001', compatibilityKey: 'semantic:aurat_female,aurat_male' });
    expect(cacheModelIdOf(model)).toBe('sem-i320@20261001');
  });
});
