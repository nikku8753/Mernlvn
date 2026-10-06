import { z } from 'zod';
export const languages = ['javascript','typescript','python','java','cpp','c'] as const;
export const profileSchema = z.object({ username: z.string().trim().min(2).max(32) });
export const registerSchema = profileSchema.extend({ email: z.string().trim().pipe(z.email().max(254)).transform(v=>v.toLowerCase()), password: z.string().min(10).max(72).refine(v=>Buffer.byteLength(v,'utf8')<=72,'Password must be at most 72 UTF-8 bytes.') });
export const loginSchema = registerSchema.pick({email:true,password:true});
export const workspaceIdSchema = z.cuid('Invalid workspace ID.');
export const workspaceSchema = z.object({ name: z.string().trim().min(1,'Workspace name is required.').max(80,'Workspace name must be at most 80 characters.'), language: z.enum(languages).default('javascript') }).strict();
export const filename = z.string().trim().min(1).max(100).regex(/^[\w. -]+$/, 'Use letters, numbers, spaces, dots, dashes, or underscores').refine(v=>v!=='.'&&v!=='..');
export const fileSchema = z.object({name:filename, type:z.enum(['FILE','FOLDER']).default('FILE'),parentId:z.cuid().nullable().default(null)}).strict();
export const fileContent = z.string().max(200_000).refine(v=>Buffer.byteLength(v,'utf8')<=200_000,'File content must be at most 200 KB.');
export const fileUpdateSchema = z.object({name:filename.optional(),content:fileContent.optional(),updatedAt:z.iso.datetime().optional()}).strict().refine(v=>v.name!==undefined||v.content!==undefined,'Provide a filename or content.').refine(v=>v.content===undefined||v.updatedAt!==undefined,'Include updatedAt when saving content.');
export const fileSaveSchema = z.object({content:fileContent,updatedAt:z.iso.datetime()}).strict();
export const messageSchema = z.object({message:z.string().trim().min(1).max(2000)});
export function canEdit(role: string) { return role === 'OWNER' || role === 'EDITOR'; }
export const starters: Record<string,{name:string;content:string}> = {
  javascript:{name:'main.js',content:'// Welcome to CodeSync. Build something together.\n\nfunction greet(name) {\n  return `Hello, ${name}!`;\n}\n\nconsole.log(greet("world"));\n'},
  typescript:{name:'main.ts',content:'function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n\nconsole.log(greet("world"));\n'},
  python:{name:'main.py',content:'def greet(name):\n    return f"Hello, {name}!"\n\nprint(greet("world"))\n'},
  java:{name:'Main.java',content:'public class Main {\n  public static void main(String[] args) {\n    System.out.println("Hello, world!");\n  }\n}\n'},
  cpp:{name:'main.cpp',content:'#include <iostream>\nint main() {\n  std::cout << "Hello, world!" << std::endl;\n}\n'},
  c:{name:'main.c',content:'#include <stdio.h>\nint main() {\n  printf("Hello, world!\\n");\n  return 0;\n}\n'},
};
