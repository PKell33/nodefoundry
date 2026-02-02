import AppStorePage from './AppStorePage';
import { umbrelConfig } from './storeConfigs';

export default function UmbrelStore() {
  return <AppStorePage config={umbrelConfig} />;
}
