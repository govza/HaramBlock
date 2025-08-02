import { Header } from '@/entrypoints/popup/components/Header';
import { HostDataProvider } from '@/entrypoints/popup/context/HostDataContext';
import { PopupLayout } from '@/entrypoints/popup/layouts/PopupLayout';

function App() {
  return (
    <HostDataProvider>
      <PopupLayout>
        <Header />
        <div className='flex'>
          <p className='mt-4'>Welcome to the HaramBlock extension popup!</p>
        </div>
      </PopupLayout>
    </HostDataProvider>
  );
}

export default App;
