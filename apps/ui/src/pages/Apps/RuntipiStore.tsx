import AppStorePage from './AppStorePage';
import { runtipiConfig } from './storeConfigs';

export default function RuntipiStore() {
  return <AppStorePage config={runtipiConfig} />;
}
