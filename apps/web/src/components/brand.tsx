import Link from 'next/link';
import {Code2} from 'lucide-react';
export function Brand(){return <Link href="/" className="brand" aria-label="CodeSync home"><span className="brand-icon"><Code2 size={21}/></span>Code<span className="brand-accent">Sync</span></Link>;}
