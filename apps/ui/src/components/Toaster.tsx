import { Toaster as SonnerToaster } from 'sonner';

export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      richColors
      closeButton
      theme="dark"
      expand
      toastOptions={{
        duration: 4000,
        style: {
          background: 'rgb(30 41 59)',
          border: '1px solid rgb(51 65 85)',
          color: 'rgb(241 245 249)',
        },
      }}
    />
  );
}
