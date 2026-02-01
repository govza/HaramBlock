import { useEffect, useState } from 'react';

import { t } from '@/utils/i18n';
import { backgroundRpc } from '@/utils/messaging/popup';

import type { ModelPreference } from '@/utils/modelSettings';

export const ModelToggle = () => {
  const [models, setModels] = useState<{ id: string; name: string; inputSize: number }[]>([]);
  const [preference, setPreference] = useState<ModelPreference | null>(null);
  const [effectiveId, setEffectiveId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

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
    setHasError(false);
    void (async () => {
      try {
        await backgroundRpc.setModelPreference(nextPreference);
        setPreference(nextPreference);
        const newEffective = await backgroundRpc.getEffectiveModelId();
        setEffectiveId(newEffective);
      } catch (error) {
        console.error('Failed to switch model:', error);
        setHasError(true);
        setTimeout(() => setHasError(false), 2000);
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

  const getTooltip = () => {
    if (hasError) return t('ModelToggle.errorTooltip');
    if (isAuto) return t('ModelToggle.autoTooltip', [effectiveId ?? '...']);
    return t('ModelToggle.manualTooltip', [models.find(m => m.id === preference)?.name ?? preference ?? '']);
  };

  const baseClasses =
    'cursor-pointer rounded border px-0.5 py-px text-[10px] font-medium disabled:cursor-wait disabled:opacity-50';
  const stateClasses = hasError ? 'border-red-500 text-red-500' : 'border-current';

  return (
    <button
      className={`${baseClasses} ${stateClasses}`}
      onClick={handleClick}
      disabled={isLoading || models.length === 0}
      title={getTooltip()}
    >
      {displayId ?? '...'}
    </button>
  );
};
