import { useEffect, useState } from 'react';

import { backgroundRpc } from '@/utils/messaging/popup';

import type { ModelPreference } from '@/utils/modelSettings';

export const ModelToggle = () => {
  const [models, setModels] = useState<{ id: string; name: string; inputSize: number }[]>([]);
  const [preference, setPreference] = useState<ModelPreference | null>(null);
  const [effectiveId, setEffectiveId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const load = async () => {
      const [available, pref, effective] = await Promise.all([
        backgroundRpc.getAvailableModels(),
        backgroundRpc.getModelPreference(),
        backgroundRpc.getEffectiveModelId(),
      ]);
      setModels(available);
      setPreference(pref);
      setEffectiveId(effective);
    };
    void load();
  }, []);

  const handleClick = () => {
    if (models.length === 0 || isLoading) return;

    // Cycle: auto → model1 → model2 → ... → auto
    // Skip the model that's already effective when leaving auto
    const options = ['auto', ...models.map(m => m.id)];
    const currentIndex = options.indexOf(preference ?? 'auto');
    let nextIndex = (currentIndex + 1) % options.length;

    // If leaving auto, skip the currently effective model
    if (preference === 'auto' && options[nextIndex] === effectiveId) {
      nextIndex = (nextIndex + 1) % options.length;
    }

    const nextPreference = options[nextIndex] as ModelPreference;

    setIsLoading(true);
    void (async () => {
      try {
        await backgroundRpc.setModelPreference(nextPreference);
        setPreference(nextPreference);
        const newEffective = await backgroundRpc.getEffectiveModelId();
        setEffectiveId(newEffective);
      } catch (error) {
        console.error('Failed to switch model:', error);
      } finally {
        setIsLoading(false);
      }
    })();
  };

  const isAuto = preference === 'auto';
  const sortedModels = [...models].sort((a, b) => a.inputSize - b.inputSize);
  const isAtMax = effectiveId === sortedModels[sortedModels.length - 1]?.id;
  const autoLabel = isAtMax ? 'auto' : '^auto';
  const displayId = isAuto ? autoLabel : preference;
  const tooltip = isAuto
    ? `Auto mode - currently using ${effectiveId ?? '...'}. Click to switch.`
    : `Model: ${models.find(m => m.id === preference)?.name ?? preference}. Click to switch.`;

  return (
    <button
      className='cursor-pointer rounded border border-current px-0.5 py-px text-[10px] font-medium disabled:cursor-wait disabled:opacity-50'
      onClick={handleClick}
      disabled={isLoading || models.length === 0}
      title={tooltip}
    >
      {displayId ?? '...'}
    </button>
  );
};
