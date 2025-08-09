import locale from '@/locales/en.json';
import _packageJson from '@/package.json';

import type { PackageJson } from 'type-fest';

const packageJson = _packageJson as PackageJson;

export const About = () => {
  const aboutData = {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    author: packageJson.author as { name: string; email: string; url: string },
    repositoryUrl: (packageJson.repository as { url: string }).url.replace('.git', ''),
  };
  return (
    <div className='space-y-6'>
      <div className='border-b border-border-primary pb-4'>
        <h2 className='text-2xl font-bold text-text-primary mb-2'>
          {locale.About.title} {aboutData.name}
        </h2>
        <p className='text-text-muted text-base'>{aboutData.description}</p>
      </div>

      <div className='space-y-4'>
        <div className='bg-secondary p-4 rounded-lg transition-all duration-200 hover:bg-surface hover:shadow-lg'>
          <h3 className='text-lg font-semibold text-text-primary mb-1'>{locale.About.extensionInformation}</h3>
          <div className='space-y-2'>
            <div className='flex gap-4'>
              <span className='text-text-body text-base'>{locale.About.version}</span>
              <span className='text-text-secondary text-base'>{aboutData.version}</span>
            </div>
            <div className='flex gap-4'>
              <span>
                {aboutData.author.name}
                {aboutData.author.email && (
                  <>
                    {' <'}
                    <a href={`mailto:${aboutData.author.email}`} className='text-accent-light hover:underline'>
                      {aboutData.author.email}
                    </a>
                    {'>'}
                  </>
                )}
                {aboutData.author.url && (
                  <>
                    {' - '}
                    <a
                      href={aboutData.author.url}
                      className='text-accent-light hover:underline'
                      target='_blank'
                      rel='noopener noreferrer'
                    >
                      {aboutData.author.url}
                    </a>
                  </>
                )}
              </span>
            </div>
          </div>
        </div>

        <div className='bg-secondary p-4 rounded-lg transition-all duration-200 hover:bg-surface hover:shadow-lg'>
          <h3 className='text-lg font-semibold text-text-primary mb-2'>{locale.About.description}</h3>
          <p className='text-text-body text-base leading-relaxed'>{aboutData.description}</p>
        </div>

        <div className='bg-secondary p-4 rounded-lg transition-all duration-200 hover:bg-surface hover:shadow-lg'>
          <h3 className='text-lg font-semibold text-text-primary mb-2'>{locale.About.supportLinks}</h3>
          <div className='space-y-2'>
            <a
              href={`${aboutData.repositoryUrl}/issues`}
              target='_blank'
              rel='noopener noreferrer'
              className='block text-accent-light hover:text-accent-muted text-base transition-colors duration-150 hover:translate-x-1'
            >
              📧 {locale.About.reportBug}
            </a>
            <a
              href={`${aboutData.repositoryUrl}/discussions`}
              target='_blank'
              rel='noopener noreferrer'
              className='block text-accent-light hover:text-accent-muted text-base transition-colors duration-150 hover:translate-x-1'
            >
              💡 {locale.About.featureRequest}
            </a>
            <a
              href={aboutData.repositoryUrl}
              target='_blank'
              rel='noopener noreferrer'
              className='block text-accent-light hover:text-accent-muted text-base transition-colors duration-150 hover:translate-x-1'
            >
              📚 {locale.About.documentation}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};
