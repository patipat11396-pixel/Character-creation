import json,struct,sys
import numpy as np
from rig import load
SRC='src.glb'
j,acc=load(SRC)
d=open(SRC,'rb').read(); L=struct.unpack('<I',d[12:16])[0]; BIN=bytearray(d[20+L+8:])
prim=j['meshes'][0]['primitives'][0]; at=prim['attributes']
P=acc(at['POSITION']).astype(np.float64)
skin=j['skins'][0]; names=[j['nodes'][i]['name'] for i in skin['joints']]
IBM=acc(skin['inverseBindMatrices']).reshape(-1,4,4).transpose(0,2,1)
JW=np.linalg.inv(IBM); JP=JW[:,:3,3]
ix={n:k for k,n in enumerate(names)}
parent={}
for ni,nd in enumerate(j['nodes']):
    for c in nd.get('children',[]): parent[j['nodes'][c].get('name')]=nd.get('name')
CHILD={'Hips':'Spine','Spine':'Spine1','Spine1':'Spine2','Spine2':'Neck','Neck':'Head',
 'LeftShoulder':'LeftArm','LeftArm':'LeftForeArm','LeftForeArm':'LeftHand',
 'RightShoulder':'RightArm','RightArm':'RightForeArm','RightForeArm':'RightHand',
 'LeftUpLeg':'LeftLeg','LeftLeg':'LeftFoot','LeftFoot':'LeftToeBase',
 'RightUpLeg':'RightLeg','RightLeg':'RightFoot','RightFoot':'RightToeBase'}
LEAF={'Head':20.0,'LeftHand':19.0,'RightHand':19.0,'LeftToeBase':9.0,'RightToeBase':9.0}
bones=[n for n in names if n!='root']
seg={}
for b in bones:
    s=JP[ix[b]]
    if b in CHILD: e=JP[ix[CHILD[b]]]
    else:
        p=parent[b]; dv=s-JP[ix[p]]; dv/=np.linalg.norm(dv); e=s+dv*LEAF[b]
    seg[b]=(s,e)
def segdist(b):
    s,e=seg[b]; d=e-s; t=np.clip(((P-s)@d)/(d@d),0,1)
    return np.linalg.norm(P-(s+t[:,None]*d),axis=1),t
D=np.stack([segdist(b)[0] for b in bones],1)
# The shoulder (clavicle) is short and buried in the chest: only claim what is really its own.
D[:,bones.index('LeftShoulder')]+=2.5; D[:,bones.index('RightShoulder')]+=2.5
near=D.argmin(1)
# The pelvis block reaches down between the thigh balls, nearer the thighs' bones than the
# hips' own: where the source rig had it on the hips, keep it there (rigid pelvis).
J0=acc(at['JOINTS_0']); W0=acc(at['WEIGHTS_0']); dom0=np.array([names[k] for k in J0[np.arange(len(J0)),W0.argmax(1)]])
for leg in ('LeftUpLeg','RightUpLeg'):
    m=(near==bones.index(leg))&(dom0=='Hips'); near[m]=bones.index('Hips'); print(leg,'-> Hips',m.sum())
def smooth(x): x=np.clip(x,0,1); return x*x*(3-2*x)
n=len(P); Jn=np.zeros((n,4),np.uint16); Wn=np.zeros((n,4),np.float32)
for i in range(n):
    b=bones[near[i]]; s,e=seg[b]; dv=(e-s)/np.linalg.norm(e-s); ln=np.linalg.norm(e-s)
    t=((P[i]-s)@dv)/ln
    w={b:1.0}
    if t<0.5 and parent.get(b) in seg:   # blend with the parent across this bone's joint
        p=parent[b]; h=min(3.5,0.3*min(ln,np.linalg.norm(seg[p][1]-seg[p][0])))
        sd=(P[i]-s)@dv; wb=smooth((sd+h)/(2*h)); w={b:wb,p:1-wb}
    elif b=='Hips' and min(np.linalg.norm(P[i]-seg[l][0]) for l in ('LeftUpLeg','RightUpLeg'))<9:
        c=min(('LeftUpLeg','RightUpLeg'),key=lambda l:np.linalg.norm(P[i]-seg[l][0])); cs,ce=seg[c]; cd=(ce-cs)/np.linalg.norm(ce-cs)
        sd=(P[i]-cs)@cd; wc=smooth((sd-1)/6)*0.5; w={b:1-wc,c:wc}
    elif t>=0.5 and b in CHILD:            # blend with the child across the far joint
        c=CHILD[b]; cs,ce=seg[c]; cd=(ce-cs)/np.linalg.norm(ce-cs)
        h=min(3.5,0.3*min(ln,np.linalg.norm(ce-cs)))
        sd=(P[i]-cs)@cd; wc=smooth((sd+h)/(2*h)); w={b:1-wc,c:wc}
    items=[(k,v) for k,v in w.items() if v>1e-3]
    tot=sum(v for _,v in items)
    for q,(k,v) in enumerate(items): Jn[i,q]=ix[k]; Wn[i,q]=v/tot
np.save('weights_J.npy',Jn); np.save('weights_W.npy',Wn)
dom=Jn[np.arange(n),Wn.argmax(1)]
print({names[k]:int(c) for k,c in zip(*np.unique(dom,return_counts=True))})
# write the fixed GLB: new JOINTS_0 / WEIGHTS_0 appended to the buffer
def add(arr,ctype,typ):
    global BIN
    while len(BIN)%4: BIN.append(0)
    off=len(BIN); raw=arr.tobytes(); BIN+=raw
    j['bufferViews'].append({'buffer':0,'byteOffset':off,'byteLength':len(raw),'target':34962})
    j['accessors'].append({'bufferView':len(j['bufferViews'])-1,'componentType':ctype,'count':len(arr),'type':typ,
        **({'max':arr.max(0).tolist(),'min':arr.min(0).tolist()} if False else {})})
    return len(j['accessors'])-1
at['JOINTS_0']=add(Jn,5123,'VEC4'); at['WEIGHTS_0']=add(Wn,5126,'VEC4')
def write(fn,j,BIN):
    while len(BIN)%4: BIN.append(0)
    j['buffers'][0]['byteLength']=len(BIN)
    js=json.dumps(j,separators=(',',':')).encode()
    while len(js)%4: js+=b' '
    out=struct.pack('<III',0x46546C67,2,12+8+len(js)+8+len(BIN))+struct.pack('<II',len(js),0x4E4F534A)+js+struct.pack('<II',len(BIN),0x004E4942)+bytes(BIN)
    open(fn,'wb').write(out)
write('fixed.glb',j,BIN)
print('wrote fixed.glb')
