import { FlipCard } from '@/entrypoints/popup/components/FlipCard';
import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { DEFAULT_GLOBAL_KEY } from '@/utils/constants';
import { t } from '@/utils/i18n';

export const Header = () => {
  const { hostSettings } = useHostDataContext();
  const isGlobalSettings = hostSettings.hostname === DEFAULT_GLOBAL_KEY;

  return (
    <FlipCard.Header className={isGlobalSettings ? 'bg-danger-bg' : 'bg-secondary'}>
      <p className='w-full truncate text-center text-xl font-medium'>
        {isGlobalSettings ? t(DEFAULT_GLOBAL_KEY) : hostSettings.hostname}
      </p>
    </FlipCard.Header>
  );
};
