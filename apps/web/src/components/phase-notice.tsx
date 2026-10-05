import Link from 'next/link';
import {ArrowLeft, Construction} from 'lucide-react';
import {Brand} from './brand';
export function PhaseNotice({title,phase}:{title:string;phase:string}){return <main className="phase-page"><Brand/><div className="phase-card"><Construction size={32} className="green"/><span className="section-kicker">DEVELOPMENT CHECKPOINT</span><h1>{title}</h1><p>This screen is scheduled for {phase}. Phase 1 establishes the project, database schema, and landing page. Account and workspace functionality is not available yet.</p><Link className="button button-secondary" href="/"><ArrowLeft size={16}/> Back to CodeSync</Link></div></main>;}
