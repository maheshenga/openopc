import { PRODUCT_BRAND } from '@kortix/product-brand';
import { ShieldCheck } from 'lucide-react';

export function AdminSidebarBrand() {
  return (
    <>
      <div className="flex h-7 w-7 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <ShieldCheck className="h-4 w-4" />
      </div>
      <div className="flex flex-col leading-tight group-data-[collapsible=icon]:hidden">
        <span className="text-sm font-semibold tracking-tight">Admin</span>
        <span className="text-xs text-muted-foreground">
          {PRODUCT_BRAND.displayName} console
        </span>
      </div>
    </>
  );
}
