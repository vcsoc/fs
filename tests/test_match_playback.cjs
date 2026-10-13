const test = require('node:test');
const assert = require('node:assert/strict');
const {matchingIntervals, MatchPlayback} = require('../fs/web/match-playback.js');
function media() {
  return {duration:30,currentTime:0,paused:true,seeking:false,playbackRate:1,
    play(){this.paused=false;return Promise.resolve()},pause(){this.paused=true}};
}
test('matching intervals are sorted, clipped, and unioned without inventing gaps', () => {
  assert.deepEqual(matchingIntervals([{start:10,end:12},{start:2,end:4},{start:3,end:6},{start:6,end:7},{start:29,end:40},{start:NaN,end:8},{start:9,end:8}],30), [{start:2,end:7},{start:10,end:12},{start:29,end:30}]);
  assert.deepEqual(matchingIntervals([{start:0,end:1}],NaN), []);
});
test('play matches skips gaps and pauses at the last listed boundary', () => {
  const m=media(),p=new MatchPlayback(m,[{start:2,end:4},{start:10,end:12}]);
  assert.equal(p.start(),true);assert.equal(m.currentTime,2);assert.equal(m.paused,false);
  m.currentTime=4;p.tick();assert.equal(m.currentTime,10);assert.equal(m.paused,false);
  m.currentTime=12;p.tick();assert.equal(m.paused,true);assert.equal(p.active,false);assert.equal(m.currentTime,12);assert.equal(p.timer,null);
});
test('pausing preserves mode and cancellation releases its boundary timer', () => {
  const m=media(),p=new MatchPlayback(m,[{start:2,end:8},{start:12,end:15}]);
  p.start();m.currentTime=4;m.pause();p.tick();assert.equal(p.active,true);assert.equal(p.timer,null);
  m.play();p.tick();assert.notEqual(p.timer,null);p.cancel();assert.equal(p.timer,null);assert.equal(p.active,false);assert.equal(m.currentTime,4);
});
test('restoration retains a paused position inside the matching union', () => {
  const m=media();m.currentTime=13;const p=new MatchPlayback(m,[{start:2,end:4},{start:12,end:15}]);
  p.start(false,true);assert.equal(m.currentTime,13);assert.equal(m.paused,true);assert.equal(p.index,1);p.cancel();
});
test('invalid, empty and beyond-duration sections cannot start playback', () => {
  const m=media(),p=new MatchPlayback(m,[{start:31,end:34},{start:4,end:4}]);
  assert.equal(p.start(),false);assert.equal(m.paused,true);assert.equal(p.active,false);
});
