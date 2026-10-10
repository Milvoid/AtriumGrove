#!/usr/bin/env python3
"""Validate the specification artifacts, not the unimplemented application.
Requires jsonschema and PyYAML; TypeScript validation is run separately.
"""
from __future__ import annotations
import copy
import hashlib
import json
import sqlite3
import shutil
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

import jsonschema
import yaml

ROOT = Path(__file__).resolve().parents[1]
checks: list[dict[str, str]] = []

def check(name: str, fn) -> None:
    try:
        fn()
    except Exception as exc:
        checks.append({'name': name, 'status': 'FAIL', 'detail': str(exc)})
        (ROOT/'validation-report.json').write_text(json.dumps({'scope':'Specification artifacts only', 'overall':'FAIL', 'checks':checks}, ensure_ascii=False, indent=2))
        raise
    else:
        checks.append({'name': name, 'status': 'PASS'})

def require(value: bool, message: str) -> None:
    if not value:
        raise AssertionError(message)

def walk_refs(value, root):
    if isinstance(value, dict):
        ref = value.get('$ref')
        if ref and ref.startswith('#/'):
            here = root
            for token in ref[2:].split('/'):
                here = here[token.replace('~1', '/').replace('~0', '~')]
        for v in value.values():
            walk_refs(v, root)
    elif isinstance(value, list):
        for v in value:
            walk_refs(v, root)

def uid(n: int) -> str:
    return str(uuid.UUID(int=n))

schema = json.loads((ROOT/'contracts/domain.schema.json').read_text())
tools = json.loads((ROOT/'contracts/tools.schema.json').read_text())
api = yaml.safe_load((ROOT/'contracts/openapi.yaml').read_text())

check('domain JSON Schema draft 2020-12 validity', lambda: jsonschema.Draft202012Validator.check_schema(schema))
check('model-facing tool argument schemas validity', lambda: jsonschema.Draft202012Validator.check_schema(tools))
check('domain internal references resolve', lambda: walk_refs(schema, schema))
check('OpenAPI internal references resolve', lambda: walk_refs(api, api))

def api_contracts():
    import re
    operations = []
    for route, methods in api['paths'].items():
        path_names = set(re.findall(r'{([^}]+)}', route))
        for method, op in methods.items():
            operations.append(op['operationId'])
            got = {p['name'] for p in op.get('parameters', []) if p['in'] == 'path'}
            require(got == path_names, f'{route}: path parameters mismatch')
            if method in ('post','patch','put','delete') and route != '/v1/auth/exchange':
                hdr = {p['name'] for p in op.get('parameters',[]) if p['in']=='header' and p.get('required')}
                require({'Idempotency-Key','X-CSRF-Token'} <= hdr, f'{route}: missing mutation guards')
    require(len(operations)==len(set(operations)), 'duplicate operationId')
    require(api['openapi']=='3.1.0', 'unexpected OpenAPI revision')
    for name, definition in schema['$defs'].items():
        def transform(v):
            if isinstance(v,dict):
                return {k:(x.replace('#/$defs/','#/components/schemas/') if k=='$ref' else transform(x)) for k,x in v.items()}
            if isinstance(v,list): return [transform(x) for x in v]
            return v
        require(api['components']['schemas'][name]==transform(definition), f'{name}: embedded schema drift')
check('OpenAPI paths, unique operations, mutation guards and schema parity', api_contracts)

def fixtures():
    for item in json.loads((ROOT/'examples/domain-fixtures.json').read_text()):
        selected = {'$ref':'#/$defs/'+item['schema'], '$defs':schema['$defs']}
        jsonschema.Draft202012Validator(selected,format_checker=jsonschema.FormatChecker()).validate(item['data'])
    for item in json.loads((ROOT/'examples/tool-fixtures.json').read_text()):
        jsonschema.Draft202012Validator(tools['$defs'][item['tool']],format_checker=jsonschema.FormatChecker()).validate(item['arguments'])
check('positive domain and collaboration-tool examples', fixtures)

def rejects_actor():
    item = json.loads((ROOT/'examples/domain-fixtures.json').read_text())[0]['data']
    bad=copy.deepcopy(item);bad['author']={'kind':'human','id':uid(1)}
    v=jsonschema.Draft202012Validator({'$ref':'#/$defs/PostMessage','$defs':schema['$defs']})
    require(not v.is_valid(bad), 'PostMessage accepted caller-controlled author')
    bad2=copy.deepcopy(item);bad2['recipientAgentIds']=[uid(20),uid(20)]
    require(not v.is_valid(bad2), 'duplicate recipients allowed')
check('schemas reject forged author and duplicate recipients', rejects_actor)

def team_check():
    team=yaml.safe_load((ROOT/'examples/team.yaml').read_text())
    agents=team['agents'];names={a['name'] for a in agents}
    require(len(agents)==5 and len(names)==5, 'team must contain 5 distinct agents')
    drivers=[a['runtime']['driver'] for a in agents]
    require(drivers.count('codex-app-server')==3 and drivers.count('claude-code-sdk')==2, '3+2 native team mismatch')
    for ch in team['channels']:
        require(set(ch['agents'])<=names,'channel references unknown agent')
    require(team['computer']['allowProviderFallback'] is False,'must not fail over desktop sessions silently')
check('five-agent team and channel references', team_check)

# SQL constraint checks use a temporary local database; no harness runs here.
with tempfile.TemporaryDirectory() as td:
    con=sqlite3.connect(str(Path(td)/'control.db'), isolation_level=None)
    check('control SQL migration executes',lambda:con.executescript((ROOT/'db/schema.sql').read_text()))
    host=sqlite3.connect(str(Path(td)/'host.db'), isolation_level=None)
    check('Host SQL migration executes',lambda:host.executescript((ROOT/'db/host.sql').read_text()))
    t='2026-10-09T06:00:00Z'
    def seed():
        for n,k in [(1,'human'),(3,'system'),(20,'agent'),(21,'agent')]:
            con.execute('INSERT INTO principals VALUES (?,?,?,?)',(uid(n),k,k+str(n),t))
        con.execute("INSERT INTO workspaces VALUES (?,? ,?,'active',1,?)",(uid(2),'Test',uid(1),t))
        con.execute("INSERT INTO hosts(id,name,credential_hash,platform,architecture,state) VALUES (?,?,?,'darwin','arm64','online')",(uid(4),'Host','test-not-credential'))
        con.execute('INSERT INTO projects VALUES (?,?,?,?,?,?,1)',(uid(5),uid(2),uid(4),'Repo','/tmp/harbor-test','HEAD'))
        for n in (20,21):
            con.execute("INSERT INTO agents VALUES (?,?,?,?,?,?,?,'[]','running','idle',1)",(uid(n),uid(2),uid(4),uid(5),'agent'+str(n),'role','{}'))
        con.execute("INSERT INTO channels VALUES (?,?,?,'',0,1)",(uid(10),uid(2),'general'))
        con.execute("INSERT INTO threads VALUES (?,?,?,'open',?)",(uid(11),uid(10),'Thread',t))
        con.execute("INSERT INTO episodes VALUES (?,?,NULL,'open','{}',0,32,1,?)",(uid(50),uid(2),t))
        con.execute("INSERT INTO messages VALUES (?,?,?,?,NULL,?,'[]','message',1,?,0,NULL,?,?,NULL)",(uid(61),uid(2),uid(10),uid(11),uid(1),uid(50),uid(60),t))
        con.execute("INSERT INTO agent_sessions VALUES (?,?,?,'native-session-1',?,1,'ready','/tmp/worktree','digest',?)",(uid(30),uid(20),'codex-app-server',uid(40),t))
        con.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,'[\"test\"]','todo',NULL,NULL,0,NULL,1)",(uid(80),uid(2),uid(10),uid(11),uid(61),'Task','description'))
    # Keep detailed fixture errors visible to prevent falsely reporting SQL pass.
    check('relational test fixture inserts',seed)
    def expect_integrity(sql, params):
        try:con.execute(sql,params)
        except sqlite3.IntegrityError:return
        raise AssertionError('Expected IntegrityError')
    check('one live session per Agent enforced',lambda:expect_integrity(
        "INSERT INTO agent_sessions VALUES (?,?,?,'native-session-2',?,2,'ready','/tmp/worktree2','d',?)",(uid(31),uid(20),'codex-app-server',uid(41),t)))
    def active_run():
        sql="INSERT INTO runs(id,agent_id,session_id,episode_id,primary_message_id,state,context_digest) VALUES (?,?,?,?,?,'running','d')"
        args=(uid(90),uid(20),uid(30),uid(50),uid(61));con.execute(sql,args)
        expect_integrity(sql,(uid(91),*args[1:]))
        con.execute("UPDATE runs SET state='unknown' WHERE id=?",(uid(90),))
        expect_integrity(sql,(uid(92),*args[1:]))
    check('running and UNKNOWN both reserve Agent execution slot',active_run)
    check('canonical source message permits only one Task',lambda:expect_integrity(
        "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,'[\"test\"]','todo',NULL,NULL,0,NULL,1)",(uid(81),uid(2),uid(10),uid(11),uid(61),'Duplicate','description')))
    def claim():
        sql="UPDATE tasks SET status='in_progress',assignee_agent_id=?,lease_epoch=lease_epoch+1,version=version+1 WHERE id=? AND status='todo' AND version=?"
        c1=con.execute(sql,(uid(20),uid(80),1)).rowcount
        c2=con.execute(sql,(uid(21),uid(80),1)).rowcount
        require((c1,c2)==(1,0),'CAS allowed two claims')
    check('Task claim compare-and-swap single winner',claim)
    def rollback():
        before=con.execute('SELECT COUNT(*) FROM events').fetchone()[0]
        con.execute('BEGIN IMMEDIATE')
        con.execute("UPDATE tasks SET version=999 WHERE id=?",(uid(80),))
        con.execute("INSERT INTO events(event_id,workspace_id,event_type,actor_id,payload_json,occurred_at) VALUES (?,?,'test',?,'{}',?)",(uid(100),uid(2),uid(1),t))
        con.execute('ROLLBACK')
        require(con.execute('SELECT version FROM tasks WHERE id=?',(uid(80),)).fetchone()[0]==2,'state did not roll back')
        require(con.execute('SELECT COUNT(*) FROM events').fetchone()[0]==before,'event did not roll back')
    check('state and event atomic rollback',rollback)
    def epoch():
        host.execute("INSERT INTO desktop_resources(resource_id,state,lease_epoch,provider) VALUES ('console','free',0,'mock')")
        first=host.execute("UPDATE desktop_resources SET state='held',lease_epoch=lease_epoch+1,owner_run_id='runA' WHERE resource_id='console' AND state='free'").rowcount
        second=host.execute("UPDATE desktop_resources SET state='held',lease_epoch=lease_epoch+1,owner_run_id='runB' WHERE resource_id='console' AND state='free'").rowcount
        require((first,second)==(1,0),'desktop admitted simultaneous owners')
        host.execute("UPDATE desktop_resources SET state='quarantined' WHERE resource_id='console'")
        require(host.execute("UPDATE desktop_resources SET state='held',lease_epoch=lease_epoch+1 WHERE resource_id='console' AND state='free'").rowcount==0,'quarantine admitted new owner')
    check('desktop conditional ownership and quarantine exclusion',epoch)
    check('database foreign keys remain valid',lambda:require(not con.execute('PRAGMA foreign_key_check').fetchall(),'foreign key violations'))
    con.close();host.close()

def doccheck():
    required=['README.md','SPEC.md','RESEARCH.md','PROTOCOLS.md','ACCEPTANCE.md','contracts/runtime.ts','db/schema.sql','db/host.sql','sources.json','prompts/standing-instructions.md','prompts/context-bundle.md']
    for f in required:require((ROOT/f).stat().st_size>0,f'missing {f}')
    manifest=json.loads((ROOT/'sources.json').read_text())
    ids={r['id'] for r in manifest['sources']}
    require(len(ids)==len(manifest['sources']),'duplicate source ID')
    import re
    for f in ['SPEC.md','PROTOCOLS.md','RESEARCH.md']:
        for hit in re.findall(r'\bR\d{2}\b',(ROOT/f).read_text()):require(hit in ids,f'{f}: missing source {hit}')
check('documentation completeness and source IDs',doccheck)

def event_validation():
    v=jsonschema.Draft202012Validator({'$ref':'#/$defs/Event','$defs':schema['$defs']})
    event=json.loads((ROOT/'examples/domain-fixtures.json').read_text())[-1]['data']
    bad=copy.deepcopy(event);bad['payload']={'message':{'id':'incomplete'}}
    require(not v.is_valid(bad), 'event payload accepted an incomplete Message')
check('canonical event payloads use typed domain objects',event_validation)

if shutil.which('tsc'):
    def typescript_check():
        result=subprocess.run(['tsc','--strict','--noEmit','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','contracts/runtime.ts'],cwd=ROOT,text=True,capture_output=True,timeout=30)
        require(result.returncode==0,result.stdout+result.stderr)
    check('TypeScript runtime contract strict typecheck',typescript_check)
else:
    checks.append({'name':'TypeScript runtime contract strict typecheck','status':'SKIP','detail':'tsc not installed'})

report={'scope':'Specification artifact checks only; no real Harness, WebUI, or Computer Use integration was executed.',
        'generatedAt':datetime.now(timezone.utc).isoformat(), 'overall':'PASS' if all(c['status']!='FAIL' for c in checks) else 'FAIL',
        'counts':{'domainDefinitions':len(schema['$defs']),'httpOperations':sum(len(v) for v in api['paths'].values()),'modelTools':len(tools['$defs']),'checks':len(checks)},
        'checks':checks,'nativeQualification':{'Q0':'NOT_RUN','Q1':'NOT_RUN','Q2':'NOT_RUN','Q3':'NOT_RUN','Q4':'NOT_RUN'}}
(ROOT/'validation-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
for c in checks: print(f"{c['status']:4} {c['name']}")
print(json.dumps(report['counts']))
