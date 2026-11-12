"""Check frontend-generated objective layouts through the real PDF/OMR pipeline."""
from pathlib import Path
import json
import shutil
import subprocess
import tempfile
import cv2
from server import paper
from server.scoring import objective_score
from server.template_checks import issues


def main(output=None):
    repo=Path(__file__).resolve().parents[1]
    node=shutil.which('node');renderer=shutil.which('pdftoppm')
    if not node or not renderer:raise RuntimeError('需要Node和Poppler')
    with tempfile.TemporaryDirectory(prefix='omp-objective-smoke-') as temporary:
        root=Path(temporary);fixture=root/'layouts.json'
        if output:
            output=Path(output);output.mkdir(parents=True,exist_ok=False)
        subprocess.run([node,'tools/test-objective-layout.mjs',str(fixture)],cwd=repo/'web',check=True)
        for index,template in enumerate(json.loads(fixture.read_text())['templates']):
            assert not issues(template,complete=True),issues(template,complete=True)
            pdf=root/f'{index}.pdf';pdf.write_bytes(paper.pdf(template))
            if output:shutil.copyfile(pdf,output/f"{template['paper']}-选择题样张.pdf")
            subprocess.run([renderer,'-r','150','-png',str(pdf),str(root/f'{index}')],check=True,capture_output=True)
            selections={}
            for page in range(1,template['sides']+1):
                image=cv2.imread(str(root/f'{index}-{page}.png'),cv2.IMREAD_GRAYSCALE)
                width,height=paper.dimensions(template);sx=image.shape[1]/width;sy=image.shape[0]/height
                blank,_=paper.decode(cv2.imencode('.png',image)[1].tobytes())
                _,_,blank_answers=paper.recognize(blank,template,'front' if page==1 else 'back')
                assert all(not selected for selected in blank_answers.values()),blank_answers
                if output:shutil.copyfile(root/f'{index}-{page}.png',output/f"{template['paper']}-第{page}面.png")
                def fill(x,y):cv2.rectangle(image,(round((x-1.5)*sx),round((y-1)*sy)),(round((x+1.5)*sx),round((y+1)*sy)),0,-1)
                if page==1:
                    for column,digit in enumerate('123'):fill(18+column*6,57+int(digit)*3.5)
                for question in template['questions']:
                    for region in question['regions']:
                        if region['page']==page:
                            for letter,x,y in paper.bubbles(question,region):
                                if letter in question['answer']:fill(x,y)
                side='front' if page==1 else 'back'
                image,code=paper.decode(cv2.imencode('.png',image)[1].tobytes())
                assert code==paper.code(template,side)
                _,candidate,answers=paper.recognize(image,template,side)
                if page==1:assert candidate=='123'
                selections.update(answers)
            total=0
            for question in template['questions']:
                assert selections[question['id']]==question['answer'],question['number']
                total+=objective_score(selections[question['id']],question['answer'],question['points'],question['rule'])
            print(json.dumps({'paper':template['paper'],'sides':template['sides'],'objective_questions':len(template['questions']),'candidate':'123','score':total/100,'status':'passed'},ensure_ascii=False))


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path);main(parser.parse_args().output)
