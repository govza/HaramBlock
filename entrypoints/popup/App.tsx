import { Header } from './components/Header';
import { HostDataProvider } from './context/HostDataContext';
import { PopupLayout } from './layouts/PopupLayout';


function App() {
  return (
    <HostDataProvider>
      <PopupLayout>
        <Header />
        <div className="flex">
          <p className="mt-4">Welcome to the HaramBlock extension popup!</p>
        </div>
      </PopupLayout>
    </HostDataProvider>
  );
};

export default App;
