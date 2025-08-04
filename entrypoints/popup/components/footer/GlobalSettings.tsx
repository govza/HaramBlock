import { useHostDataContext } from '@/entrypoints/popup/context/HostDataContext';
import { defaultGlobalKey } from '@/utils/db/constants';

export const GlobalSettings = () => {
  const { hostSettings } = useHostDataContext();
  const isGlobal = hostSettings.hostname === defaultGlobalKey;

  const handleClick = () => {
    // Toggle between global and current hostname
    // This would need to be implemented based on your app's global state management
    console.log('Toggle global settings clicked');
  };

  return (
    <button className="mr-1 cursor-pointer" onClick={handleClick}>
      {isGlobal && (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="red"
          className="size-6">
          <path d="M4,14V17C4,19 7.05,20.72 11,21V18.11L11.13,18C7.12,17.76 4,16.06 4,14M12,13C7.58,13 4,11.21 4,9V12C4,14.21 7.58,16 12,16C12.39,16 12.77,16 13.16,16L17,12.12C15.4,12.72 13.71,13 12,13M12,3C7.58,3 4,4.79 4,7C4,9.21 7.58,11 12,11C16.42,11 20,9.21 20,7C20,4.79 16.42,3 12,3M21,11.13C20.85,11.13 20.71,11.19 20.61,11.3L19.61,12.3L21.66,14.3L22.66,13.3C22.87,13.1 22.88,12.76 22.66,12.53L21.42,11.3C21.32,11.19 21.18,11.13 21.04,11.13M19.04,12.88L13,18.94V21H15.06L21.12,14.93L19.04,12.88Z" />
        </svg>
      )}
      {!isGlobal && (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="size-6">
          <path d="M12 3L2 12H5V20H10V14H14V15.11L19.43 9.68L12 3M21.04 11.14C20.9 11.14 20.76 11.2 20.65 11.3L19.65 12.3L21.7 14.35L22.7 13.35C22.91 13.14 22.91 12.79 22.7 12.58L21.42 11.3C21.32 11.2 21.18 11.14 21.04 11.14M19.06 12.88L13 18.94V21H15.06L21.11 14.93L19.06 12.88Z" />
        </svg>
      )}
    </button>
  );
};
