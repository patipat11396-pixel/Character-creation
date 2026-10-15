import json,struct,sys
import numpy as np
def load(fn):
    d=open(fn,'rb').read(); L=struct.unpack('<I',d[12:16])[0]; j=json.loads(d[20:20+L]); b=d[20+L+8:]
    def acc(i):
        a=j['accessors'][i]; bv=j['bufferViews'][a['bufferView']]
        n={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}[a['type']]
        dt={5126:np.float32,5123:np.uint16,5121:np.uint8,5125:np.uint32}[a['componentType']]
        isz=np.dtype(dt).itemsize; off=bv.get('byteOffset',0)+a.get('byteOffset',0); st=bv.get('byteStride') or n*isz
        if st==n*isz: return np.frombuffer(b,dtype=dt,count=a['count']*n,offset=off).reshape(a['count'],n).copy()
        raw=np.frombuffer(b,dtype=dt,offset=off,count=(st*(a['count']-1)+n*isz)//isz)
        return np.lib.stride_tricks.as_strided(raw,shape=(a['count'],n),strides=(st,isz)).copy()
    return j,acc
def joints(fn):
    j,acc=load(fn); s=j['skins'][0]
    IBM=acc(s['inverseBindMatrices']).reshape(-1,4,4).transpose(0,2,1)
    W=np.linalg.inv(IBM); names=[j['nodes'][i]['name'] for i in s['joints']]
    return {n:W[k] for k,n in enumerate(names)}
if __name__=='__main__':
    A=joints('src.glb'); B=joints('male.glb'); F=joints('/home/user/Character-creation/models/character_female.glb') if False else None
    ch={'Hips':'Spine','Spine':'Spine1','Spine1':'Spine2','Spine2':'Neck','Neck':'Head','LeftArm':'LeftForeArm','LeftForeArm':'LeftHand','LeftUpLeg':'LeftLeg','LeftLeg':'LeftFoot','LeftFoot':'LeftToeBase','LeftShoulder':'LeftArm','RightArm':'RightForeArm','RightLeg':'RightFoot'}
    for a,c in ch.items():
        la=A[c][:3,3]-A[a][:3,3]; lb=B[c][:3,3]-B[a][:3,3]
        print(f'{a:13s} mann {np.linalg.norm(la):6.1f} dir {np.round(la/np.linalg.norm(la),2)}   char {np.linalg.norm(lb):6.1f} dir {np.round(lb/np.linalg.norm(lb),2)}')
    print('hips', A['Hips'][:3,3], B['Hips'][:3,3]); print('head', A['Head'][:3,3], B['Head'][:3,3])
    np.set_printoptions(precision=2,suppress=True)
    for n in ['Hips','LeftArm','LeftUpLeg','Head']: print(n,'\n',A[n][:3,:3],'\n',B[n][:3,:3])
