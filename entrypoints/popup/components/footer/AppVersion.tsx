import packageJson from '@/package.json';

export const AppVersion = () => {
  return (
    <div className="ml-auto">
      <p className="text-sm text-gray-300">v{packageJson.version}</p>
    </div>
  );
};
