"""Run a standalone candidate task before changing the live ECS service.
Uses existing service networking and task-role permissions; never prints environment values.
"""
import json, os, subprocess, time

def aws(*args):
    return json.loads(subprocess.check_output(['aws',*args,'--region',os.environ['AWS_REGION'],'--output','json']))

cluster=os.environ['ECS_CLUSTER']; service=os.environ['ECS_SERVICE']; definition=os.environ['TASK_DEF_ARN']
svc=aws('ecs','describe-services','--cluster',cluster,'--services',service)['services'][0]
td=aws('ecs','describe-task-definition','--task-definition',definition)['taskDefinition']
container=next(c for c in td['containerDefinitions'] if c.get('essential',True))
payload={'cluster':cluster,'taskDefinition':definition,'count':1,'startedBy':'coreg-institutional-preflight','networkConfiguration':svc['networkConfiguration'],'overrides':{'containerOverrides':[{'name':container['name'],'command':['node','scripts/preflight-institutional.cjs']}]}}
if svc.get('capacityProviderStrategy'): payload['capacityProviderStrategy']=svc['capacityProviderStrategy']
else: payload['launchType']=svc.get('launchType','FARGATE')
result=aws('ecs','run-task','--cli-input-json',json.dumps(payload))
if result.get('failures') or len(result.get('tasks',[]))!=1: raise RuntimeError('Candidate preflight task did not start')
arn=result['tasks'][0]['taskArn']
try:
    for _ in range(90):
        tasks=aws('ecs','describe-tasks','--cluster',cluster,'--tasks',arn).get('tasks',[])
        if len(tasks)!=1: raise RuntimeError('Candidate preflight task is unavailable')
        task=tasks[0]
        if task['lastStatus']=='STOPPED':
            cs=task.get('containers',[])
            match=next((c for c in cs if c['name']==container['name']),{})
            if match.get('exitCode')!=0: raise RuntimeError('Candidate preflight failed; production service unchanged')
            print('Candidate preflight passed; production has not yet been changed')
            break
        time.sleep(5)
    else: raise RuntimeError('Candidate preflight timed out')
finally:
    aws('ecs','stop-task','--cluster',cluster,'--task',arn,'--reason','Institutional preflight finished')
