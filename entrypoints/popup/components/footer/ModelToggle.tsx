import { useEffect, useState } from 'react';

import { t } from '@/utils/i18n';
import { backgroundRpc } from '@/utils/messaging/popup';
import { onModelSettingsChange, type ModelPreference } from '@/utils/modelSettings';

type ModelInfo = { id: string; name: string; inputSize: number };

// Compact label, e.g. `sem-i320` → `s320` (first id letter + input size).
const formatModelLabel = (model: ModelInfo | undefined): string =>
  model ? `${model.id.charAt(0) || 's'}${model.inputSize}` : '';

export const ModelToggle = () => {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [preference, setPreference] = useState<ModelPreference | null>(null);
  const [effectiveId, setEffectiveId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let active = true;

    const loadModels = async () => {
      const available = await backgroundRpc.getAvailableModels();
      if (active) setModels(available);
    };

    // The background persists every auto/manual switch via setModelSettings, so re-read the
    // effective model whenever settings change to keep the label live (no popup reopen needed).
    const refreshSelection = async () => {
      const [pref, effective] = await Promise.all([
        backgroundRpc.getModelPreference(),
        backgroundRpc.getEffectiveModelId(),
      ]);
      if (active) {
        setPreference(pref);
        setEffectiveId(effective);
      }
    };

    void loadModels();
    void refreshSelection();
    const unsubscribe = onModelSettingsChange(() => void refreshSelection());

    return () => {
      active = false;
      unsubscribe();
    };
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
  const singleModel = models.length === 1 ? models[0] : undefined;
  const sortedModels = [...models].sort((a, b) => a.inputSize - b.inputSize);
  const isAtMax = effectiveId === sortedModels[sortedModels.length - 1]?.id;
  const effectiveModel = models.find(m => m.id === effectiveId);
  const getDisplayId = () => {
    if (singleModel) return formatModelLabel(singleModel);
    if (isAuto) {
      const autoPrefix = isAtMax ? 'auto' : '^auto';
      const effectiveLabel = formatModelLabel(effectiveModel);
      return effectiveLabel ? `${autoPrefix} - ${effectiveLabel}` : autoPrefix;
    }
    return formatModelLabel(models.find(m => m.id === preference)) || preference || '...';
  };
  const displayId = getDisplayId();

  const getTooltip = () => {
    if (hasError) return t('ModelToggle.errorTooltip');
    if (singleModel) return t('ModelToggle.singleModelTooltip', [singleModel.name]);
    if (isAuto) return t('ModelToggle.autoTooltip', [effectiveModel?.name ?? effectiveId ?? '...']);
    return t('ModelToggle.manualTooltip', [models.find(m => m.id === preference)?.name ?? preference ?? '']);
  };

  const baseClasses = 'cursor-pointer rounded border px-0.5 py-px text-[10px] font-medium disabled:opacity-50';
  const cursorClass = isLoading ? 'disabled:cursor-wait' : 'disabled:cursor-default';
  const stateClasses = hasError ? 'border-red-500 text-red-500' : 'border-current';

  return (
    <button
      className={`${baseClasses} ${cursorClass} ${stateClasses}`}
      onClick={handleClick}
      disabled={isLoading || models.length === 0 || Boolean(singleModel)}
      title={getTooltip()}
    >
      {displayId}
    </button>
  );
};
