# The re-weighted mannequin, moved onto a game body's bind pose (male/female): each bone's
# piece turned onto the body's bone and stretched along it to the body's length.
import json,struct,io,sys
import numpy as np
from PIL import Image
from rig import load, joints
j,acc=load('fixed.glb')
prim=j['meshes'][0]['primitives'][0]; at=prim['attributes']
P=acc(at['POSITION']).astype(np.float64); N=acc(at['NORMAL']).astype(np.float64); UV=acc(at['TEXCOORD_0']).astype(np.float32)
Jn=acc(at['JOINTS_0']); Wn=acc(at['WEIGHTS_0'])
names=[j['nodes'][i]['name'] for i in j['skins'][0]['joints']]
CHILD={'Hips':'Spine','Spine':'Spine1','Spine1':'Spine2','Spine2':'Neck','Neck':'Head',
 'LeftShoulder':'LeftArm','LeftArm':'LeftForeArm','LeftForeArm':'LeftHand',
 'RightShoulder':'RightArm','RightArm':'RightForeArm','RightForeArm':'RightHand',
 'LeftUpLeg':'LeftLeg','LeftLeg':'LeftFoot','LeftFoot':'LeftToeBase',
 'RightUpLeg':'RightLeg','RightLeg':'RightFoot','RightFoot':'RightToeBase'}
PARENT={c:p for p,c in CHILD.items()}
def align(a,b):
    a=a/np.linalg.norm(a); b=b/np.linalg.norm(b); v=np.cross(a,b); c=a@b
    if np.linalg.norm(v)<1e-9: return np.eye(3)
    K=np.array([[0,-v[2],v[1]],[v[2],0,-v[0]],[-v[1],v[0],0]]); return np.eye(3)+K+K@K/(1+c)
# textures: smaller (the source PNGs are 22 MB)
imgs=[]
d=open('src.glb','rb').read(); L=struct.unpack('<I',d[12:16])[0]; js=json.loads(d[20:20+L]); B=d[20+L+8:]
for im in js['images']:
    bv=js['bufferViews'][im['bufferView']]; raw=B[bv.get('byteOffset',0):bv.get('byteOffset',0)+bv['byteLength']]
    o=io.BytesIO(); Image.open(io.BytesIO(raw)).convert('RGB').resize((1024,1024),Image.LANCZOS).save(o,'JPEG',quality=88); imgs.append(o.getvalue())
mat=js['materials'][0]
JM=joints('fixed.glb')
for body in ('male','female'):
    JC=joints(f'{body}.glb')
    cnames=list(JC.keys())
    assert cnames[:len(names)]==names, 'joint order differs'
    M={}
    for b in names:
        if b=='root': M[b]=(np.eye(3),JM[b][:3,3],JC[b][:3,3]); continue
        if b in CHILD:
            dm=JM[CHILD[b]][:3,3]-JM[b][:3,3]; dc=JC[CHILD[b]][:3,3]-JC[b][:3,3]
            u=dm/np.linalg.norm(dm); s=np.linalg.norm(dc)/np.linalg.norm(dm)
            A=align(dm,dc)@(np.eye(3)+(s-1)*np.outer(u,u))
        else:   # the ends (head, hands, toes): turned with their parent, not stretched
            p=PARENT[b]; A=align(JM[b][:3,3]-JM[p][:3,3],JC[b][:3,3]-JC[p][:3,3])
        M[b]=(A,JM[b][:3,3],JC[b][:3,3])
    P2=np.zeros_like(P); N2=np.zeros_like(N)
    for k in range(4):
        for bi in np.unique(Jn[:,k]):
            m=(Jn[:,k]==bi)&(Wn[:,k]>0); 
            if not m.any(): continue
            A,o,t=M[names[bi]]; w=Wn[m,k][:,None]
            P2[m]+=w*((P[m]-o)@A.T+t)
            N2[m]+=w*(N[m]@np.linalg.inv(A))   # (inverse transpose)
    N2/=np.linalg.norm(N2,axis=1,keepdims=True)
    # a fresh, small GLB: the mesh alone (plain, the game binds it to the body's skeleton)
    bufs=bytearray(); views=[]; accs=[]
    def add(arr,ctype,typ,target=34962,mm=False):
        global bufs
        while len(bufs)%4: bufs.append(0)
        raw=arr.tobytes(); views.append({'buffer':0,'byteOffset':len(bufs),'byteLength':len(raw),**({'target':target} if target else {})}); bufs+=raw
        a={'bufferView':len(views)-1,'componentType':ctype,'count':len(arr),'type':typ}
        if mm: a['min']=arr.min(0).tolist(); a['max']=arr.max(0).tolist()
        accs.append(a); return len(accs)-1
    attrs={'POSITION':add(P2.astype(np.float32),5126,'VEC3',mm=True),'NORMAL':add(N2.astype(np.float32),5126,'VEC3'),
           'TEXCOORD_0':add(UV,5126,'VEC2'),'JOINTS_0':add(Jn.astype(np.uint16),5123,'VEC4'),'WEIGHTS_0':add(Wn.astype(np.float32),5126,'VEC4')}
    images=[]
    for raw in imgs:
        while len(bufs)%4: bufs.append(0)
        views.append({'buffer':0,'byteOffset':len(bufs),'byteLength':len(raw)}); bufs+=raw
        images.append({'bufferView':len(views)-1,'mimeType':'image/jpeg'})
    out={'asset':{'version':'2.0','generator':'mannequin transfer'},'scene':0,'scenes':[{'nodes':[0]}],
         'nodes':[{'name':'Mannequin','mesh':0,'rotation':[-0.7071067811865476,0,0,0.7071067811865476]}],
         'meshes':[{'name':'Mannequin','primitives':[{'attributes':attrs,'material':0}]}],
         'materials':[{'name':'Mannequin','pbrMetallicRoughness':{'baseColorFactor':mat['pbrMetallicRoughness']['baseColorFactor'],'metallicFactor':0,'roughnessFactor':0.8,'baseColorTexture':{'index':0}},'normalTexture':{'index':1}}],
         'textures':[{'sampler':0,'source':0},{'sampler':0,'source':1}],'samplers':[{'magFilter':9729,'minFilter':9987,'wrapS':10497,'wrapT':10497}],
         'images':images,'accessors':accs,'bufferViews':views,'buffers':[{'byteLength':0}],
         'extras':{'joints':names}}
    while len(bufs)%4: bufs.append(0)
    out['buffers'][0]['byteLength']=len(bufs)
    s=json.dumps(out,separators=(',',':')).encode()
    while len(s)%4: s+=b' '
    open(f'mannequin_{body}.glb','wb').write(struct.pack('<III',0x46546C67,2,28+len(s)+len(bufs))+struct.pack('<II',len(s),0x4E4F534A)+s+struct.pack('<II',len(bufs),0x004E4942)+bytes(bufs))
    print(body,'bbox',np.round(P2.min(0),1),np.round(P2.max(0),1),'bytes',28+len(s)+len(bufs))
