import { useParams, Navigate } from 'react-router-dom';
import AppStorePage from './AppStorePage';
import { getStoreConfig } from './storeConfigs';

/**
 * Dynamic store page that reads store type from URL parameter.
 * Replaces individual UmbrelStore, Start9Store, CasaOSStore, RuntipiStore components.
 */
export default function StorePage() {
  const { store } = useParams<{ store: string }>();

  const config = store ? getStoreConfig(store) : undefined;

  if (!config) {
    // Invalid store type - redirect to apps index
    return <Navigate to="/apps" replace />;
  }

  return <AppStorePage config={config} />;
}
