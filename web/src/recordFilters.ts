export type FilterField<T>={key:string;label:string;options:{value:string;label:string}[];values:(row:T)=>string[]}
export type FilterValues=Record<string,string[]>

export function textMatches(value:unknown,term:string):boolean {
  if(value==null)return false
  if(typeof value==='object')return Object.values(value).some(v=>textMatches(v,term))
  return String(value).toLocaleLowerCase().includes(term)
}

export function filterRecords<T>(records:readonly T[],fields:FilterField<T>[],filters:FilterValues,query:string,searchField=''){
  const term=query.trim().toLocaleLowerCase(),field=fields.find(f=>f.key===searchField)
  return records.filter(row=>fields.every(f=>!filters[f.key]?.length||f.values(row).some(value=>filters[f.key].includes(value)))&&
    (!term||textMatches(field?field.values(row).map(value=>field.options.find(o=>o.value===value)?.label||value):row,term)))
}
