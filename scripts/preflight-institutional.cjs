'use strict';
// Read-only runtime check. It does not migrate, activate schemas or mint approvals.
(async()=>{try{const result=await require('../api/services/institutional-readiness').check();console.log(JSON.stringify({status:'pass',...result}));}catch(e){console.error(JSON.stringify({status:'blocked',reason:e.message}));process.exitCode=1;}finally{await Promise.all(Object.values(require('../api/services/db')).map(p=>p.end()));}})();
