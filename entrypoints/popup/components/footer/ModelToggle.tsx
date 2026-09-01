import { useEffect, useState } from 'react';

import { t } from '@/utils/i18n';
import { backgroundRpc } from '@/utils/messaging/popup';
import { onModelSettingsChange, type ModelPreference } from '@/utils/modelSettings';
import { getLogger } from '@/utils/telemetry';

const log = getLogger('ModelToggle');

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

    // The background persists every auto/manual switch via setModelSettings, so re-read the loaded
    // model whenever settings change to keep the label live (no popup reopen needed).
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

  const sortedModels = [...models].sort((a, b) => a.inputSize - b.inputSize);
  const isAuto = preference === 'auto';

  const handleClick = () => {
    if (sortedModels.length === 0 || isLoading) return;

    // Cycle: auto → model1 → model2 → ... → auto. When leaving auto, skip the model that is
    // already effective - selecting it manually would be a no-op switch.
    const options = ['auto', ...sortedModels.map(m => m.id)];
    const currentIndex = options.indexOf(preference ?? 'auto');
    let nextIndex = (currentIndex + 1) % options.length;
    if (isAuto && options[nextIndex] === effectiveId) {
      nextIndex = (nextIndex + 1) % options.length;
    }

    const next = options[nextIndex];
    if (!next) return;

    setIsLoading(true);
    setHasError(false);
    void (async () => {
      try {
        await backgroundRpc.setModelPreference(next);
        setPreference(next);
        const newEffective = await backgroundRpc.getEffectiveModelId();
        setEffectiveId(newEffective);
      } catch (error) {
        log.error('model.switch.failed', { preference: next, error });
        setHasError(true);
        setTimeout(() => setHasError(false), 2000);
      } finally {
        setIsLoading(false);
      }
    })();
  };

  const singleModel = models.length === 1 ? models[0] : undefined;
  const effectiveModel = models.find(m => m.id === effectiveId);
  const selectedModel = isAuto ? effectiveModel : models.find(m => m.id === preference);

  const getDisplayId = () => {
    if (singleModel) return formatModelLabel(singleModel);
    if (isAuto) {
      const effectiveLabel = formatModelLabel(effectiveModel);
      return effectiveLabel ? `auto·${effectiveLabel}` : 'auto';
    }
    return formatModelLabel(selectedModel) || preference || '...';
  };

  const getTooltip = () => {
    if (hasError) return t('ModelToggle.errorTooltip');
    if (singleModel) return t('ModelToggle.singleModelTooltip', [singleModel.name]);
    if (isAuto) return t('ModelToggle.autoTooltip', [effectiveModel?.name ?? effectiveId ?? '...']);
    return t('ModelToggle.manualTooltip', [selectedModel?.name ?? preference ?? '']);
  };

  const baseClasses = 'cursor-pointer rounded border px-0.5 py-px text-[10px] font-medium disabled:opacity-50';
  const cursorClass = isLoading ? 'disabled:cursor-wait' : 'disabled:cursor-default';
  const stateClasses = hasError ? 'border-red-500 text-red-500' : borderColorClass(selectedModel);

  return (
    <button
      className={`${baseClasses} ${cursorClass} ${stateClasses}`}
      onClick={handleClick}
      disabled={isLoading || models.length === 0 || Boolean(singleModel)}
      title={getTooltip()}
    >
      {getDisplayId()}
    </button>
  );
};
