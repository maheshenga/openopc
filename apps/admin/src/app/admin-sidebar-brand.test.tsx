import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AdminSidebarBrand } from './_components/admin-sidebar-brand';

test('renders the OpenOPC brand in persistent Admin navigation', () => {
  const html = renderToStaticMarkup(<AdminSidebarBrand />);

  expect(html).toContain('OpenOPC console');
});
