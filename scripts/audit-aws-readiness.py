"""Read-only CoreIdentity inventory. Never serializes credential values."""
import json,subprocess,re,datetime
from pathlib import Path
result={'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mode':'read-only','account_expected':'636058550262'}
def aws(*args):
 p=subprocess.run(['aws',*args,'--region','us-east-2','--output','json'],capture_output=True,text=True,timeout=40)
 if p.returncode:
  code=re.search(r'\(([^)]+)\) when calling',p.stderr)
  raise RuntimeError(code.group(1) if code else 'AWS_API_ERROR')
 return json.loads(p.stdout)
def check(name,fn):
 try:result[name]=fn()
 except Exception as e:result[name]={'error':str(e) if isinstance(e,RuntimeError) else type(e).__name__}
identity=aws('sts','get-caller-identity')
if identity['Account']!='636058550262':raise RuntimeError('Unexpected AWS account')
result['identity']={k:identity[k] for k in ['Account','Arn']}
check('service',lambda:[{k:s.get(k) for k in ['serviceName','status','desiredCount','runningCount','pendingCount','taskDefinition','deployments']} for s in aws('ecs','describe-services','--cluster','coreidentity-prod','--services','pcm-api')['services']])
def task():
 td=aws('ecs','describe-task-definition','--task-definition','coreidentity-prod-pcm-api')['taskDefinition']
 return {'arn':td['taskDefinitionArn'],'task_role':td.get('taskRoleArn'),'containers':[{'name':c['name'],'image':c['image'],'environment_names':sorted(e['name'] for e in c.get('environment',[])),'secret_names':sorted(e['name'] for e in c.get('secrets',[]))} for c in td['containerDefinitions']]}
check('task',task)
check('database',lambda:[{k:d.get(k) for k in ['DBInstanceIdentifier','DBInstanceStatus','StorageEncrypted','BackupRetentionPeriod','LatestRestorableTime','MultiAZ','PubliclyAccessible','DeletionProtection','EngineVersion']} for d in aws('rds','describe-db-instances','--db-instance-identifier','coreidentity-pcm')['DBInstances']])
check('identity_pools',lambda:[{'name':p['Name'],'id':p['Id']} for p in aws('cognito-idp','list-user-pools','--max-results','60')['UserPools']])
check('bucket_names',lambda:[b['Name'] for b in aws('s3','list-buckets')['Buckets'] if any(k in b['Name'].lower() for k in ['coreg','pcm','vault'])])
check('secret_names',lambda:[s['Name'] for s in aws('secretsmanager','list-secrets')['SecretList'] if any(k in s['Name'].lower() for k in ['coreg','pcm','scanner','cognito'])])
Path('aws-readiness.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
