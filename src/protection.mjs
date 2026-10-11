// An actionable QQQ exit wins immediately. A data failure must not prevent
// independent option-price protection for an already-held position.
export async function protectedDecision({ readDecision, ensureProtection }) {
  try{return {decision:await readDecision()};}
  catch(error){
    const protection=await ensureProtection();
    const data_error=String(error.message).slice(0,200);
    return {decision:protection.needs_exit?{...protection,exit:true}:
      {exit:false,reason:'qqq_data_unavailable'},protection,data_error};
  }
}
