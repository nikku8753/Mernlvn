import type {LucideIcon} from 'lucide-react';
export function FeatureCard({icon:Icon,title,description,label}:{icon:LucideIcon;title:string;description:string;label:string}){return <article className="feature-card"><div className="feature-top"><span className="feature-icon"><Icon size={22}/></span><span className="feature-label">{label}</span></div><h3>{title}</h3><p>{description}</p></article>;}
