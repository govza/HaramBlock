export const About = () => {
  return (
    <div className='space-y-6'>
      <div className='border-b border-border-primary pb-4'>
        <h2 className='text-2xl font-bold text-text-primary mb-2'>About HaramBlock</h2>
        <p className='text-text-muted text-base'>Information about this extension</p>
      </div>

      <div className='space-y-4'>
        <div className='bg-secondary p-4 rounded-lg transition-all duration-200 hover:bg-surface hover:shadow-lg'>
          <h3 className='text-lg font-semibold text-text-primary mb-2'>Extension Information</h3>
          <div className='space-y-2'>
            <div className='flex justify-between'>
              <span className='text-text-body text-base'>Version:</span>
              <span className='text-text-secondary text-base'>1.0.0</span>
            </div>
            <div className='flex justify-between'>
              <span className='text-text-body text-base'>Developer:</span>
              <span className='text-text-secondary text-base'>HaramBlock Team</span>
            </div>
            <div className='flex justify-between'>
              <span className='text-text-body text-base'>Last Updated:</span>
              <span className='text-text-secondary text-base'>January 2025</span>
            </div>
          </div>
        </div>

        <div className='bg-secondary p-4 rounded-lg transition-all duration-200 hover:bg-surface hover:shadow-lg'>
          <h3 className='text-lg font-semibold text-text-primary mb-2'>Description</h3>
          <p className='text-text-body text-base leading-relaxed'>
            HaramBlock is a content filtering extension designed to help users maintain a clean and safe browsing
            experience. It provides customizable blocking rules, whitelist management, and advanced filtering options to
            protect against unwanted content.
          </p>
        </div>

        <div className='bg-secondary p-4 rounded-lg transition-all duration-200 hover:bg-surface hover:shadow-lg'>
          <h3 className='text-lg font-semibold text-text-primary mb-2'>Support & Links</h3>
          <div className='space-y-2'>
            <a
              href='#'
              className='block text-accent-light hover:text-accent-muted text-base transition-colors duration-150 hover:translate-x-1'
            >
              📧 Report a Bug
            </a>
            <a
              href='#'
              className='block text-accent-light hover:text-accent-muted text-base transition-colors duration-150 hover:translate-x-1'
            >
              💡 Feature Request
            </a>
            <a
              href='#'
              className='block text-accent-light hover:text-accent-muted text-base transition-colors duration-150 hover:translate-x-1'
            >
              📚 Documentation
            </a>
            <a
              href='#'
              className='block text-accent-light hover:text-accent-muted text-base transition-colors duration-150 hover:translate-x-1'
            >
              🌟 Rate this Extension
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};
