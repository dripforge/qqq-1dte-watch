export function optionQuoteReader(cached, fetchFresh, {clock=()=>Date.now(),maxAgeMs=10000}={}) {
  let unused=true;
  return async()=>{
    if(unused){
      unused=false;
      const age=clock()-Date.parse(cached?.updated_at??'');
      if(cached&&Number.isFinite(age)&&age>=-5000&&age<=maxAgeMs)return cached;
    }
    return fetchFresh();
  };
}
