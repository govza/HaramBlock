import { useEffect, useState } from 'react';

import { t } from '@/utils/i18n';
import { backgroundRpc } from '@/utils/messaging/popup';
import { onModelSettingsChange } from '@/utils/modelSettings';

type ModelInfo = { id: string; name: string; inputSize: number };

// Compact label, e.g. `sem-i320` → `s320` (first id letter + input size).
const formatModelLabel = (model: ModelInfo | undefined): string =>
  model ? `${model.id.charAt(0) || 's'}${model.inputSize}` : '';

// Border color by input size: small = green (fast), mid = yellow, large = red (heavy).
const borderColorClass = (model: ModelInfo | undefined): string => {
  if (!model) return 'border-current';
  if (model.inputSize <= 320) return 'border-green-500';
  if (model.inputSize <= 448) return 'border-yellow-500';
  return 'border-red-500';
};

export const ModelToggle = () => {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let active = true;

    const loadModels = async () => {
      const available = await backgroundRpc.getAvailableModels();
      if (active) setModels(available);
    };

    // The background persists every manual switch via setModelSettings, so re-read the loaded model
    // whenever settings change to keep the label live (no popup reopen needed).
    const refreshSelection = async () => {
      const effective = await backgroundRpc.getEffectiveModelId();
      if (active) setCurrentId(effective);
    };

    void loadModels();
    void refreshSelection();
    const unsubscribe = onModelSettingsChange(() => void refreshSelection());

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const sortedModels = [...models].sort((a, b) => a.inputSize - b.inputSize);

  const handleClick = () => {
    if (sortedModels.length === 0 || isLoading) return;

    // Cycle through the available models in ascending input-size order.
    const currentIndex = sortedModels.findIndex(m => m.id === currentId);
    const next = sortedModels[(currentIndex + 1) % sortedModels.length];
    if (!next) return;

    setIsLoading(true);
    setHasError(false);
    void (async () => {
      try {
        await backgroundRpc.setModelPreference(next.id);
        setCurrentId(next.id);
      } catch (error) {
        console.error('Failed to switch model:', error);
        setHasError(true);
        setTimeout(() => setHasError(false), 2000);
      } finally {
        setIsLoading(false);
      }
    })();
  };

  const singleModel = models.length === 1 ? models[0] : undefined;
  const currentModel = models.find(m => m.id === currentId);
  const displayId = formatModelLabel(currentModel) || currentId || '...';

  const getTooltip = () => {
    if (hasError) return t('ModelToggle.errorTooltip');
    if (singleModel) return t('ModelToggle.singleModelTooltip', [singleModel.name]);
    return t('ModelToggle.manualTooltip', [currentModel?.name ?? currentId ?? '']);
  };

  const baseClasses = 'cursor-pointer rounded border px-0.5 py-px text-[10px] font-medium disabled:opacity-50';
  const cursorClass = isLoading ? 'disabled:cursor-wait' : 'disabled:cursor-default';
  const stateClasses = hasError ? 'border-red-500 text-red-500' : borderColorClass(currentModel);

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
