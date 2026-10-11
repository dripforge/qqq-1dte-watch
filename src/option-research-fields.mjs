export const OPTION_RESEARCH_FIELDS=Object.freeze(['gamma','vega','implied_volatility','volume','open_interest']);
export function optionResearchFields(raw={}){
 return Object.fromEntries(OPTION_RESEARCH_FIELDS.map(key=>{
  const x=raw[key],n=(typeof x==='number'||typeof x==='string'&&x.trim()!=='')?Number(x):NaN;
  const valid=Number.isFinite(n)&&n>=0&&(!['volume','open_interest'].includes(key)||Number.isSafeInteger(n));
  return [key,valid?n:null];
 }));
}
