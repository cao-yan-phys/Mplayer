const $ = (id) => document.getElementById(id)
const names = ['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B']
const name = (pitch) => names[pitch % 12] + (Math.floor(pitch / 12) - 1)
const scales = {major:[0,2,4,5,7,9,11],minor:[0,2,3,5,7,8,10],harmonic:[0,2,3,5,7,8,11],melodic:[0,2,3,5,7,9,11],dorian:[0,2,3,5,7,9,10],mixolydian:[0,2,4,5,7,9,10]}
const chords = {major:[0,4,7],minor:[0,3,7],diminished:[0,3,6],augmented:[0,4,8],dominant7:[0,4,7,10],major7:[0,4,7,11],minor7:[0,3,7,10]}
let context
let sources = []
let timers = []
let generation = 0
const stop = () => {
  generation += 1
  sources.forEach((source) => {try{source.stop()}catch{}})
  sources = []
  timers.forEach(clearTimeout)
  timers = []
  document.querySelectorAll('.active').forEach((element) => element.classList.remove('active'))
}
const later = (callback, delay) => timers.push(setTimeout(callback, delay * 1000))
async function play(events, flashes = []) {
  stop()
  const playbackGeneration = generation
  context ??= new AudioContext()
  await context.resume()
  if (generation !== playbackGeneration) return
  const base = context.currentTime + 0.05
  events.forEach(([pitch,time,duration,level = 0.15]) => {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.setPeriodicWave(context.createPeriodicWave(new Float32Array(5),new Float32Array([0,1,0.2,0.06,0.02])))
    oscillator.frequency.value = 440 * 2 ** ((pitch - 69) / 12)
    gain.gain.setValueAtTime(0,base + time)
    gain.gain.linearRampToValueAtTime(level,base + time + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.001,base + time + duration)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start(base + time)
    oscillator.stop(base + time + duration + 0.03)
    oscillator.onended = () => {oscillator.disconnect();gain.disconnect()}
    sources.push(oscillator)
    const key = document.querySelector(`[data-pitch="${pitch}"]`)
    if(key){later(()=>key.classList.add('active'),time+0.05);later(()=>key.classList.remove('active'),time+duration+0.05)}
  })
  flashes.forEach(([index,time,duration])=>{later(()=>$('beats').children[index]?.classList.add('active'),time+0.05);later(()=>$('beats').children[index]?.classList.remove('active'),time+duration+0.05)})
}
function options(id, values) {$(id).replaceChildren(...values.map(([value,label])=>new Option(label,value)))}
function noteList(id,pitches,labels) {$(id).replaceChildren(...pitches.map((pitch,index)=>{const span=document.createElement('span');span.textContent=labels?.[index] ?? name(pitch);return span}))}
const degree = (pitch) => [0,0,1,2,2,3,3,4,5,5,6,6][pitch % 12] + (Math.floor(pitch / 12) - 5) * 7
function staff(id,pitches,together=false,spellings){
  const svg=$(id)
  const elements=[]
  const add=(tag,attrs)=>{const node=document.createElementNS('http://www.w3.org/2000/svg',tag);Object.entries(attrs).forEach(([key,value])=>node.setAttribute(key,value));elements.push(node);return node}
  for(let index=0;index<5;index++)add('line',{x1:20,x2:620,y1:40+index*14,y2:40+index*14,stroke:'#999','stroke-width':1})
  const clef=add('text',{x:30,y:82,'font-family':'Bravura','font-size':56,fill:'#333'})
  clef.textContent='\uE050'
  let previousY = Infinity
  let previousHeadX = 320
  pitches.forEach((pitch,index)=>{
    const x=together?320:320+(index-(pitches.length-1)/2)*70
    const spelling=spellings?.[index] ?? name(pitch)
    const letter=['C','D','E','F','G','A','B'].indexOf(spelling[0])
    const y=110-(spellings ? letter+(Math.floor(pitch/12)-5)*7 : degree(pitch))*7
    for(let ledger=110;ledger<=y;ledger+=14)add('line',{x1:x-14,x2:x+14,y1:ledger,y2:ledger,stroke:'#777'})
    for(let ledger=26;ledger>=y;ledger-=14)add('line',{x1:x-14,x2:x+14,y1:ledger,y2:ledger,stroke:'#777'})
    const headX = together && Math.abs(y - previousY) <= 7 && previousHeadX === x ? x + 13 : x
    add('ellipse',{cx:headX,cy:y,rx:7,ry:5,fill:'#286265',transform:`rotate(-15 ${headX} ${y})`})
    previousY = y
    previousHeadX = headX
    if(/[♭♯𝄪]/u.test(spelling)){const accidental=add('text',{x:x-24-(together ? index % 2 * 24 : 0),y:y+5,'font-size':18,fill:'#333','text-anchor':'end'});accidental.textContent=spelling.slice(1).replace(/[0-9]/g,'')}
    if (!together) {
      const label=add('text',{x,y:145,'font-size':13,'text-anchor':'middle',fill:'#555'});label.textContent=spelling
    }
  })
  svg.replaceChildren(...elements)
}
const whitePitches=[]
for(let pitch=60;pitch<=84;pitch++)if(![1,3,6,8,10].includes(pitch%12))whitePitches.push(pitch)
whitePitches.forEach((pitch)=>{const button=document.createElement('button');button.className='white';button.dataset.pitch=pitch;button.setAttribute('aria-label',name(pitch));button.innerHTML=`<span>${name(pitch)}</span>`;$('keyboard').append(button)})
for(let pitch=60;pitch<84;pitch++)if([1,3,6,8,10].includes(pitch%12)){const button=document.createElement('button');button.className='black';button.dataset.pitch=pitch;button.style.left=`${whitePitches.filter((white)=>white<pitch).length/whitePitches.length*100}%`;button.setAttribute('aria-label',name(pitch));$('keyboard').append(button)}
$('keyboard').addEventListener('pointerdown',(event)=>{const key=event.target.closest('[data-pitch]');if(!key)return;const pitch=Number(key.dataset.pitch);$('pitch-readout').textContent=`${name(pitch)} · ${(440*2**((pitch-69)/12)).toFixed(2)} Hz`;staff('pitch-staff',[pitch]);void play([[pitch,0,0.8]])})
const intervals=['Unison','Minor second','Major second','Minor third','Major third','Perfect fourth','Tritone','Perfect fifth','Minor sixth','Major sixth','Minor seventh','Major seventh','Octave']
options('interval',intervals.map((label,index)=>[index,label]))
$('interval').value='4'
options('tonic',[[0,'C'],[2,'D'],[4,'E'],[5,'F'],[7,'G'],[9,'A'],[11,'B']])
options('chord-root',[[0,'C'],[2,'D'],[4,'E'],[5,'F'],[7,'G'],[9,'A'],[11,'B']])
const keys=[['C major','A minor',0,9,'No sharps or flats'],['G major','E minor',7,4,'1 sharp: F♯'],['D major','B minor',2,11,'2 sharps: F♯ C♯'],['F major','D minor',5,2,'1 flat: B♭'],['B♭ major','G minor',10,7,'2 flats: B♭ E♭']]
options('key',keys.map((key,index)=>[index,key[0]]))
const naturalLetters=['C','D','E','F','G','A','B']
const naturalPcs=[0,2,4,5,7,9,11]
function scaleData(){const root=Number($('tonic').value);const pattern=scales[$('scale').value];const first=naturalPcs.indexOf(root);const pitches=[...pattern,12].map((offset)=>60+root+offset);const labels=pitches.map((pitch,index)=>{const letterIndex=(first+index)%7;let offset=(pitch%12-naturalPcs[letterIndex]+18)%12-6;return naturalLetters[letterIndex]+(offset===1?'♯':offset===-1?'♭':offset===2?'𝄪':'')});return {pitches,labels,pattern}}
function chordPitches(){const root=60+Number($('chord-root').value);const pitches=chords[$('chord').value].map((offset)=>root+offset);for(let i=0;i<Number($('inversion').value);i++)pitches.push(pitches.shift()+12);return pitches}
function chordSpellings(){const root=Number($('chord-root').value);const first=naturalPcs.indexOf(root);const labels=chords[$('chord').value].map((offset,index)=>{const letter=(first+index*2)%7;const difference=((root+offset)%12-naturalPcs[letter]+18)%12-6;return naturalLetters[letter]+(difference===1?'♯':difference===-1?'♭':difference===2?'𝄪':difference===-2?'♭♭':'')});for(let i=0;i<Number($('inversion').value);i++)labels.push(labels.shift());return labels.map((label,index)=>label+(Math.floor(chordPitches()[index]/12)-1))}
const progressions={authentic:[[62,65,69],[55,59,62,65],[60,64,67]],plagal:[[53,57,60],[60,64,67]],half:[[60,64,67],[62,65,69],[55,59,62]],deceptive:[[55,59,62],[57,60,64]]}
const romans={authentic:['ii','V7','I'],plagal:['IV','I'],half:['I','ii','V'],deceptive:['V','vi']}
function refresh(){
  const interval=Number($('interval').value);staff('interval-staff',[60,60+interval]);$('interval-readout').textContent=`${intervals[interval]} · ${interval} semitone${interval===1?'':'s'}`
  const scale=scaleData();noteList('scale-notes',scale.pitches,scale.labels);$('scale-steps').textContent='Steps: '+[...scale.pattern,12].slice(1).map((value,index)=>value-scale.pattern[index]).join(' · ')
  const key=keys[Number($('key').value)];$('key-readout').textContent=`${key[0]} / ${key[1]} · ${key[4]}`
  const count=chords[$('chord').value].length;const previous=$('inversion').value;options('inversion',Array.from({length:count},(_,index)=>[index,['Root position','First inversion','Second inversion','Third inversion'][index]]));$('inversion').value=previous !== '' && Number(previous)<count?previous:'0'
  const pitches=chordPitches();const spellings=chordSpellings();noteList('chord-notes',pitches,spellings);$('chord-staff').setAttribute('viewBox','0 -70 640 230');staff('chord-staff',pitches,true,spellings)
  noteList('progression-notes',progressions[$('progression').value].map((chord)=>chord[0]),romans[$('progression').value])
  $('tempo-value').textContent=$('tempo').value+' BPM'
  const meter=Number($('meter').value);$('beats').replaceChildren(...Array.from({length:meter},(_,index)=>{const beat=document.createElement('span');beat.className='beat'+((meter===6?index%3===0:index===0)?' strong':'');beat.textContent=index+1;return beat}))
}
document.querySelectorAll('select,input').forEach((element)=>element.addEventListener('input',refresh))
const sequence=(pitches,step=0.38)=>pitches.map((pitch,index)=>[pitch,index*step,step*0.85])
document.querySelectorAll('[data-play]').forEach((button)=>button.addEventListener('click',()=>{
  const kind=button.dataset.play
  let events=[];let flashes=[]
  if(kind==='rhythm'){const meter=Number($('meter').value);const step=60/Number($('tempo').value)/(meter===6?3:1);for(let i=0;i<meter*2;i++){events.push([i%meter===0?84:79,i*step,0.07,0.1]);flashes.push([i%meter,i*step,step*0.8])}}
  if(kind==='interval-up')events=sequence([60,60+Number($('interval').value)],0.6)
  if(kind==='interval-together')events=[60,60+Number($('interval').value)].map((pitch)=>[pitch,0,1.3])
  if(kind==='scale')events=sequence(scaleData().pitches)
  if(kind.startsWith('key-')){const key=keys[Number($('key').value)];const root=60+(kind==='key-major'?key[2]:key[3]);const pattern=kind==='key-major'?scales.major:scales.minor;events=sequence([0,2,4,3,1,6,0].map((degree)=>root+pattern[degree]),0.45)}
  if(kind==='chord')events=chordPitches().map((pitch)=>[pitch,0,1.4,0.11])
  if(kind==='arpeggio')events=sequence(chordPitches(),0.45)
  if(kind==='progression')events=progressions[$('progression').value].flatMap((chord,index)=>chord.map((pitch)=>[pitch,index*1.2,1.1,0.1]))
  void play(events,flashes)
}))
$('stop').addEventListener('click',stop)
window.addEventListener('pagehide',stop)
document.querySelector('nav').replaceChildren(...Array.from(document.querySelectorAll('section')).map((section)=>{const link=document.createElement('a');link.href='#'+section.id;link.textContent=section.querySelector('h2').textContent.split(' · ')[1];return link}))
staff('pitch-staff',[60])
refresh()
