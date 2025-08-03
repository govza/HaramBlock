import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { t } from '@/utils/i18n';

export const Outline = () => {
  const { hostSettings } = useHostDataContext();

  const handleChange = (outline: OutlineType) => {
    void hostSettings.setOutline(outline);
  };

  return (
    <div className='my-2 flex flex-col rounded-full bg-gray-400 text-sm'>
      <div className='flex rounded-full bg-gray-400 p-1'>
        <button
          className={`flex-1 rounded-full p-1 text-center transition cursor-pointer ${
            hostSettings.outline === 'bbox' ? 'bg-gray-600' : 'text-gray-800'
          }`}
          onClick={() => handleChange('bbox')}
        >
          {t('outlineBoundingBox')}
        </button>
        <button
          className={`flex-1 rounded-full p-1 text-center transition cursor-pointer ${
            hostSettings.outline === 'segment'
              ? 'bg-gray-600 text-gray-100'
              : 'text-gray-800'
          }`}
          onClick={() => handleChange('segment')}
        >
          {t('outlineSegment')}
        </button>
      </div>
    </div>
  );
};
