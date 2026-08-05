import { getRequestConfig } from 'next-intl/server';

import messages from '../../translations/en.json';

export default getRequestConfig(async () => ({
  locale: 'en',
  messages,
  timeZone: 'UTC',
}));
