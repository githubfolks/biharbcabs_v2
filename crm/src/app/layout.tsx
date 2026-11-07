import './globals.css';
import type { Metadata } from 'next';
import SidebarLayout from '@/components/SidebarLayout';

export const metadata: Metadata = {
  title: 'BiharCabs CRM & WhatsApp Dispatch Engine',
  description: 'Operational CRM and Automated Dispatch System for BiharCabs.com',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 min-h-screen font-sans antialiased overflow-hidden">
        <SidebarLayout>{children}</SidebarLayout>
      </body>
    </html>
  );
}
