import { useEffect, useState } from 'react';

import { backgroundRpc } from '@/utils/messaging/popup';

export const ModelToggle = () => {
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const loadModels = async () => {
      const available = await backgroundRpc.getAvailableModels();
      const current = await backgroundRpc.getCurrentModelId();
      setModels(available);
      setCurrentId(current);
    };
    void loadModels();
  }, []);

  const handleClick = () => {
    if (models.length < 2 || isLoading) return;

    const currentIndex = models.findIndex(m => m.id === currentId);
    const nextIndex = (currentIndex + 1) % models.length;
    const nextModel = models[nextIndex];
    if (!nextModel) return;

    setIsLoading(true);
    void backgroundRpc.setCurrentModel(nextModel.id).then(() => {
      setCurrentId(nextModel.id);
      setIsLoading(false);
    });
  };

  const currentModel = models.find(m => m.id === currentId);
  const displayName = currentModel?.name ?? currentId ?? 'Loading...';

  return (
    <button
      className='cursor-pointer rounded border border-current px-0.5 py-px text-[10px] font-medium disabled:cursor-wait disabled:opacity-50'
      onClick={handleClick}
      disabled={isLoading || models.length < 2}
      title={`Current model: ${displayName}. Click to switch.`}
    >
      {currentId ?? '...'}
    </button>
  );
};
