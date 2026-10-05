import { config } from './config.js';
import { HttpError } from './permissions.js';
const languageIds:Record<string,number>={javascript:63,python:71};
export async function execute(language:string,code:string,stdin:string) {
  if(!config.EXECUTION_URL)throw new HttpError(503,'Code execution is unavailable. Configure an isolated Judge0 service to enable it.');
  if(!languageIds[language])throw new HttpError(422,'Execution currently supports JavaScript and Python. You can still edit all six languages.');
  const response=await fetch(`${config.EXECUTION_URL.replace(/\/$/,'')}/submissions?base64_encoded=true&wait=true`,{method:'POST',headers:{'Content-Type':'application/json',...(config.EXECUTION_API_KEY?{'X-Auth-Token':config.EXECUTION_API_KEY}:{})},body:JSON.stringify({language_id:languageIds[language],source_code:Buffer.from(code).toString('base64'),stdin:Buffer.from(stdin).toString('base64'),cpu_time_limit:2,wall_time_limit:5,memory_limit:65536,max_processes_and_or_threads:16,max_file_size:64,enable_network:false}),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new HttpError(502,'The execution service could not run your code. Try again later.');
  const body=await response.text();if(body.length>200_000)throw new HttpError(502,'Execution output exceeded the limit.');const result=JSON.parse(body);
  const decode=(v?:string)=>v?Buffer.from(v,'base64').toString('utf8').slice(0,16000):'';
  return {stdout:decode(result.stdout),stderr:decode(result.stderr),compileOutput:decode(result.compile_output),status:result.status?.description||'Unknown',time:result.time,memory:result.memory};
}
