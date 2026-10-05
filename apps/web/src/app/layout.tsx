import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'CodeSync — Code together. Build together.',description:'A collaborative coding workspace for developers. Real-time editing, shared projects, and team chat.'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>;}
