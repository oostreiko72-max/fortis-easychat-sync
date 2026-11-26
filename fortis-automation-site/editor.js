(function () {
  'use strict';
  var STORAGE = 'fortis.staff.editor.v1';
  var FORMAT = 'fortis.staff.edits.v1';
  var UPLOAD_URL = 'https://github.com/oostreiko72-max/fortis-easychat-sync/upload/fortis-automation-map-site/fortis-automation-site';
  var ADMIN_API = 'https://fortis-fitbase-admin-api.onrender.com';
  var TYPES = ['Воронка','Задача','Сообщение','Начисление бонусов','Push','Тег','Заявка'];
  var STYLES = {'Воронка':['funnel','⑂'],'Задача':['task','☷'],'Сообщение':['message','◌'],'Начисление бонусов':['bonus','✦'],'Push':['push','♧'],'Тег':['tag','⌑'],'Заявка':['lead','＋']};
  var source = {cards:{},stages:{}};
  var draft = {cards:{},stages:{}};
  var editing = false;
  var mode = null;
  var editingId = null;
  var modal;
  var stages = [];

  function q(s, root) { return (root || document).querySelector(s); }
  function all(s, root) { return Array.prototype.slice.call((root || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function safeJSON(value) { return JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026'); }
  function validState(x) {
    return x && typeof x === 'object' && !Array.isArray(x) && x.cards && typeof x.cards === 'object' && !Array.isArray(x.cards)
      && x.stages && typeof x.stages === 'object' && !Array.isArray(x.stages);
  }
  function cardId(card) {
    var href = q('.link[href*="/automatic/update?id="]',card);
    var match = href && href.getAttribute('href').match(/[?&]id=(\d+)/);
    return match ? match[1] : (card.getAttribute('data-fe-id') || null);
  }
  function cardById(id) {
    return all('details.rule').find(function (c) { return cardId(c) === String(id); }) || null;
  }
  function stageById(id) {
    return all('.stage').find(function (s) { return s.getAttribute('data-fe-stage') === String(id); }) || null;
  }
  function cardStage(card) {
    var view = card.closest('.view');
    if (view && view.getAttribute('data-view') === 'Г') return 'Г';
    var stage = card.closest('.stage');
    return stage ? stage.getAttribute('data-fe-stage') : 'Г';
  }
  function stagesList() {
    return all('.stage').map(function (s) {
      var id = s.getAttribute('data-fe-stage');
      return {id:id, title:q('.stname',s).textContent.trim()};
    });
  }
  function options(selected) {
    var a = stagesList().concat([{id:'Г', title:'Глобальные / Общие'}]);
    return a.map(function (x) {
      return '<option value="' + esc(x.id) + '"' + (selected===x.id?' selected':'') + '>' + esc(x.id + ' — ' + x.title) + '</option>';
    }).join('');
  }
  function parseName(field) {
    var e = q('.key',field);
    if (!e) return '';
    var text = '';
    Array.prototype.forEach.call(e.childNodes,function (n) {
      if (n.nodeType === 3) text += n.textContent;
    });
    return (text || e.textContent).replace(/\s+/g,' ').trim();
  }
  function parseFields(card) {
    var detail = q('.details',card);
    if (!detail) return [];
    return all(':scope > .field',detail).map(function (f) {
      var rest = Array.prototype.slice.call(f.children).filter(function (n) { return !n.classList.contains('key'); });
      var value = rest.map(function (n) { return n.innerText || n.textContent || ''; }).join('\n').trim();
      return {label:parseName(f),value:value,body:!!q('.bodytext',f)};
    }).filter(function (f) { return f.label; });
  }
  function setTaskPriorityMarker(card) {
    var badge=q('summary .kind',card);
    if(!badge)return;
    if(card.getAttribute('data-kind')!=='Задача') {
      badge.classList.remove('fe-priority-important');
      return;
    }
    // Read only task-priority fields, never the task body or automation enabled state.
    var evidence=parseFields(card).filter(function(f){
      return /^(?:Параметры(?: задачи)?|Переход\s*\/\s*результат|Статус задачи|Приоритет(?: задачи)?|Срочность)$/i.test(f.label);
    }).map(function(f){return f.value;}).join('; ');
    var statuses=[];
    var pattern=/(?:Статус(?: задачи)?|Приоритет(?: задачи)?|Срочность)\s*[:=]\s*(Важная|Обычная)(?=$|[\s;,.|])/gi;
    var hit;
    while((hit=pattern.exec(evidence))!==null)statuses.push(hit[1].toLowerCase());
    // Unknown or conflicting statuses stay neutral.
    var important=statuses.length?statuses.every(function(s){return s==='важная';})
      : /(?:^|[;,.])\s*Важная(?=\s*(?:$|[;,.]))/i.test(evidence);
    badge.classList.toggle('fe-priority-important',important);
  }
  function updateDisabledMarker(card) {
    var foot=q('summary .rfoot',card);
    if(!foot)return;
    var statusFields=parseFields(card).filter(function(f){
      return /^(?:Статус|Статус автодействия|Состояние)$/i.test(f.label);
    });
    var isOff=statusFields.some(function(f){
      return /^(?:ВЫКЛ|ВЫКЛЮЧЕНО|ОТКЛЮЧЕНО|НЕАКТИВНО|DISABLED|INACTIVE|OFF|FALSE)(?=$|[\s(:;,.])/i.test(f.value.trim());
    });
    var badges=all('.fe-disabled-label',foot);
    if(!isOff) {
      badges.forEach(function(e){e.remove();});
      return;
    }
    var badge=badges.shift();
    badges.forEach(function(e){e.remove();});
    if(!badge){
      badge=document.createElement('span');
      badge.className='fe-disabled-label';
    }
    badge.textContent='ОТКЛЮЧЕНО';
    var id=q('.id',foot);
    if(id && id.nextElementSibling!==badge)id.insertAdjacentElement('afterend',badge);
    else if(!badge.isConnected)foot.appendChild(badge);
  }
  // Only presentation text is cleaned; identifiers, links and Fitbase rules are unchanged.
  function formatStatusLabel(value) {
    var s=String(value||'').trim();
    if(/^(?:Выключено|Отключено|ВЫКЛ|ОТКЛ|disabled|inactive|off|false)(?=$|[\s(:;,.])/i.test(s))return 'Выключено';
    if(/^(?:Включено|ВКЛ|Активно|Активна|Активен|active|enabled)(?=$|[\s(:;,.])/i.test(s))return 'Активно';
    return 'Требует проверки';
  }
  function stripTechnicalText(value) {
    var placeholders=[], s=String(value||'');
    s=s.replace(/\{\{[^{}]+\}\}/g,function(m){
      var tag='\uE000'+placeholders.length+'\uE001';placeholders.push([tag,m]);return tag;
    });
    s=s.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\s*\(([^()]*[А-Яа-яЁё][^()]*)\)/gi,function(_,title){return title;});
    s=s.replace(/\s*[\[(](?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?:\s*[=:]\s*[^)\]]+)?|(?:value|id)\s*[=:]\s*[^)\]]+|enabled|unchecked|offset)\s*[\])]/gi,'');
    s=s.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?:\s*=\s*(?:"|&quot;)?[a-z0-9]+(?:"|&quot;)?)?/gi,'');
    s=s.replace(/^[ \t]*[—–-]\s*/gm,'').replace(/ {2,}/g,' ').replace(/ +([.,;])/g,'$1');
    placeholders.forEach(function(x){s=s.split(x[0]).join(x[1]);});
    return s;
  }
  function cleanTextNodes(node) {
    Array.prototype.forEach.call(node.childNodes,function(child){
      if(child.nodeType===3)child.nodeValue=stripTechnicalText(child.nodeValue);
      else if(child.nodeType===1)cleanTextNodes(child);
    });
  }
  function isFunnelOnlyTextField(label) {
    return /^(?:Текст задачи\s*\/\s*сообщения|Текст сообщения|Текст задачи|Полный текст задачи\s*\/\s*сообщения)$/i.test(String(label||'').trim());
  }
  function tidyCardDetails(card) {
    var details=q('.details',card);
    if(!details)return;
    var isFunnel=card.getAttribute('data-kind')==='Воронка';
    all(':scope > .field',details).forEach(function(field){
      var label=parseName(field);
      // Funnel transitions have no task/message body — do not show empty placeholder fields.
      if(isFunnel && isFunnelOnlyTextField(label)){field.remove();return;}
      var values=Array.prototype.filter.call(field.children,function(n){return n.nodeType===1&&!n.classList.contains('key');});
      if(label==='Статус') {
        field.classList.add('fe-status-field');
        if(values.length)values[0].textContent=formatStatusLabel(values[0].textContent);
      } else {
        values.forEach(cleanTextNodes);
      }
    });
    all(':scope > .warn',details).forEach(cleanTextNodes);
  }
  function parseWarnings(card) {
    var detail = q('.details',card);
    return detail ? all(':scope > .warn',detail).map(function (n) { return n.textContent.trim(); }).filter(Boolean).join('\n\n') : '';
  }
  function readCard(card) {
    return {
      id:cardId(card),
      code:q('.seq',card)?.textContent.trim() || '',
      title:q('.rname',card)?.textContent.trim() || '',
      kind:card.getAttribute('data-kind') || 'Задача',
      isCall:card.classList.contains('staff-call'),
      stage:cardStage(card),
      fields:parseFields(card),
      notes:parseWarnings(card),
      created:card.getAttribute('data-fe-created') === 'true'
    };
  }
  function stageData(stage) {
    return {
      id:stage.getAttribute('data-fe-stage'),
      title:q('.stname',stage)?.textContent.trim()||'',
      goal:(q('.objective',stage)?.textContent||'').replace(/^Цель:\s*/,'').trim(),
      duty:(q('.duty',stage)?.textContent||'').replace(/^Задача:\s*/,'').trim(),
      color:stage.style.getPropertyValue('--sc')?.trim() || '#b8aea9'
    };
  }
  function sanitizeColor(color) {
    return /^#[0-9a-f]{6}$/i.test(String(color||''))?color:'#b8aea9';
  }
  function saveDraft() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(draft));
      updateStatus();
      return true;
    } catch (e) {
      alert('Не удалось сохранить изменения в браузере. Проверьте настройки хранилища и свободное место.');
      return false;
    }
  }
  function merged() {
    return {
      cards:Object.assign({},source.cards,draft.cards),
      stages:Object.assign({},source.stages,draft.stages)
    };
  }
  function addFieldRow(data) {
    data = data || {label:'Новое поле',value:'',body:false};
    var row = document.createElement('div');
    row.className = 'fe-fieldrow';
    row.innerHTML = '<label class="fe-key">Название поля<input class="fe-field-label" maxlength="150" required></label>'
       + '<label class="fe-value">Содержимое<textarea class="fe-field-value" rows="3"></textarea>'
       + '<span class="fe-checkbox"><input class="fe-field-body" type="checkbox"> Показывать как большой текст</span></label>'
       + '<button class="fe-remove" type="button" title="Удалить поле" data-fe-action="remove-field">×</button>';
    q('.fe-field-label',row).value = data.label || '';
    q('.fe-field-value',row).value = data.value || '';
    q('.fe-field-body',row).checked = !!data.body;
    q('#fe-fields').appendChild(row);
  }
  function editorUI() {
    var bar = document.createElement('div');
    bar.id = 'fe-toolbar';
    bar.className = 'fe-toolbar';
    bar.innerHTML =
      '<div class="fe-toolbar__left">'
      + '<button type="button" class="fe-primary" data-fe-action="toggle">✎ Редактировать</button>'
      + '<button type="button" data-fe-action="new-card">＋ Новая карточка</button>'
      + '<button type="button" data-fe-action="export-json">↓ Резервная копия JSON</button>'
      + '<button type="button" data-fe-action="import-json">↑ Импорт изменений</button>'
      + '</div>'
      + '<div class="fe-toolbar__right">'
      + '<button type="button" class="fe-primary" data-fe-action="publish">✓ Сохранить и опубликовать</button>'
      + '<button type="button" data-fe-action="export-html">↓ Скачать сайт HTML</button>'
      + '<a target="_blank" rel="noopener noreferrer" href="' + UPLOAD_URL + '">Опубликовать через GitHub ↗</a>'
      + '<button type="button" class="fe-warn" data-fe-action="reset">Сбросить черновик</button>'
      + '</div>'
      + '<div class="fe-status" id="fe-status"></div>'
      + '<input id="fe-file" type="file" accept=".json,application/json" hidden>';
    var provenance=q('.provenance');
    if (provenance) provenance.insertAdjacentElement('afterend',bar);
    else q('main')?.insertBefore(bar,q('main').firstChild);
    var hint = document.createElement('p');
    hint.className='fe-hint';
    hint.textContent='Правки сначала сохраняются только в вашем браузере. Кнопка «Сохранить и опубликовать» отправит их в GitHub через защищённый сервер, после чего Render обновит сайт. Публикация не меняет Fitbase.';
    bar.insertAdjacentElement('afterend',hint);

    modal = document.createElement('dialog');
    modal.id='fe-dialog';
    modal.className='fe-dialog';
    modal.innerHTML =
       '<form id="fe-form" novalidate>'
     + '<div class="fe-dialog__header"><div><h2 id="fe-title">Редактировать</h2><p>Изменения сайта не меняют настройки CRM Fitbase</p></div>'
     + '<button type="button" class="fe-headclose" data-fe-action="close" aria-label="Закрыть">×</button></div>'
     + '<div class="fe-dialog__content">'
     + '<div id="fe-card-area"><div class="fe-grid">'
     + '<label>ID Fitbase<input id="fe-id" type="number" min="1" step="1" required></label>'
     + '<label>Номер на карточке<input id="fe-code" required maxlength="40" placeholder="1.1.2 или Г-27"></label>'
     + '<label class="fe-wide">Название автодействия<input id="fe-card-title" required maxlength="250"></label>'
     + '<label>Тип действия<select id="fe-type"></select></label>'
     + '<label>Воронка / этап<select id="fe-location"></select></label>'
     + '<label class="fe-wide fe-checkbox fe-call-choice" id="fe-call-row"><input id="fe-call" type="checkbox"> ☎ Это задача на звонок — показывать «Звонок» на закрытой карточке. Красная рамка только при статусе задачи «Важная»</label></div>'
     + '<h3 class="fe-subtitle">Поля карточки</h3>'
     + '<div id="fe-fields"></div>'
     + '<button type="button" class="fe-add-field" data-fe-action="add-field">＋ Добавить поле</button>'
     + '<label>Примечания и предупреждения<textarea id="fe-notes" rows="3"></textarea></label>'
     + '<p class="fe-note">Оставляйте фактические данные Fitbase и ваши инструкции в разных полях. Ссылка на автодействие формируется по ID и не редактируется.</p></div>'
     + '<div id="fe-stage-area" hidden><div class="fe-grid">'
     + '<label class="fe-wide">Название этапа<input id="fe-stage-title" required></label>'
     + '<label class="fe-wide">Цель этапа<textarea id="fe-goal" rows="3"></textarea></label>'
     + '<label class="fe-wide">Задача администратора<textarea id="fe-duty" rows="3"></textarea></label>'
     + '<label>Цвет этапа<input id="fe-color" type="color" value="#b8aea9"></label></div>'
     + '<p class="fe-note">Название, цель и цвет изменяются только на сайте, а не в CRM.</p></div>'
     + '</div>'
     + '<div class="fe-dialog__footer"><button type="button" data-fe-action="close">Отмена</button><button class="fe-save" type="submit">Сохранить в браузере</button></div>'
     + '</form>';
    document.body.appendChild(modal);
    q('#fe-type').innerHTML=TYPES.map(function (x) {return '<option>'+esc(x)+'</option>';}).join('');
    q('#fe-form').addEventListener('submit', onSubmit);
    q('#fe-file').addEventListener('change', importJSON);
    updateStatus();
    setEditing(false);
  }
  function toast(text) {
    var e=q('.fe-flash');
    if(e)e.remove();
    e=document.createElement('div');
    e.className='fe-flash';
    e.setAttribute('role','status');
    e.textContent=text;
    document.body.appendChild(e);
    setTimeout(function(){e.remove();},3600);
  }
  function updateStatus() {
    var count = Object.keys(draft.cards).length + Object.keys(draft.stages).length;
    var el=q('#fe-status');
    if (el) el.innerHTML = '<strong>Черновик: '+count+' изменений.</strong> '
      +'Только в этом браузере, пока вы не опубликуете скачанный HTML. ';
  }
  function setEditing(value) {
    editing = !!value;
    document.body.classList.toggle('fe-on',editing);
    var b=q('[data-fe-action="toggle"]');
    if(b) b.textContent=editing?'✓ Завершить редактирование':'✎ Редактировать';
  }
  function addEditButtons() {
    all('.stage').forEach(function (s) {
      if(!s.getAttribute('data-fe-stage')){
        var v=q('.snum',s);
        if(v)s.setAttribute('data-fe-stage',v.textContent.replace(/^ЭТАП\s*/,'').trim());
      }
      var head=q('.sthead',s);
      if(head && !q('.fe-edit-stage',head)){
        var b=document.createElement('button');
        b.className='fe-edit-stage';b.type='button';b.textContent='✎ Этап';
        head.insertBefore(b,head.firstChild);
      }
    });
    all('details.rule').forEach(function (c) {
      var id=cardId(c);
      if(id)c.setAttribute('data-fe-id',id);
      var summary=q('summary',c);
      if(summary&&!q('.fe-edit-card',summary)){
        var btn=document.createElement('button');
        btn.className='fe-edit-card';btn.type='button';btn.textContent='✎';
        btn.title='Редактировать карточку';btn.setAttribute('aria-label','Редактировать карточку');
        summary.appendChild(btn);
      }
    });
  }
  function openCard(card, isNew) {
    mode='card';editingId=isNew?null:cardId(card);
    q('#fe-card-area').hidden=false;q('#fe-stage-area').hidden=true;
    var data=isNew?{id:'',code:'',title:'',kind:'Задача',stage:'1.1',
      fields:[{label:'Триггер',value:'',body:false},{label:'Условия',value:'',body:false},{label:'Действие',value:'',body:false},{label:'Полный текст задачи / сообщения',value:'',body:true}],
      notes:'Добавлено вручную на сайт; точные параметры необходимо сверить в Fitbase.',created:true}:readCard(card);
    q('#fe-title').textContent=isNew?'Новая карточка':'Карточка ID '+data.id;
    q('#fe-id').disabled=!isNew;q('#fe-id').value=data.id||'';
    q('#fe-code').value=data.code;q('#fe-card-title').value=data.title;
    q('#fe-type').value=TYPES.indexOf(data.kind)>=0?data.kind:'Задача';
    q('#fe-call').checked=!!data.isCall;
    q('#fe-call-row').hidden=q('#fe-type').value!=='Задача';
    q('#fe-location').innerHTML=options(data.stage);
    q('#fe-location').value=data.stage;
    q('#fe-notes').value=data.notes||'';
    q('#fe-fields').innerHTML='';
    (data.fields||[]).forEach(addFieldRow);
    modal.showModal();
  }
  function openStage(stage) {
    var data=stageData(stage);
    mode='stage';editingId=data.id;
    q('#fe-card-area').hidden=true;q('#fe-stage-area').hidden=false;
    q('#fe-title').textContent='Этап '+data.id;
    q('#fe-stage-title').value=data.title;
    q('#fe-goal').value=data.goal;q('#fe-duty').value=data.duty;
    q('#fe-color').value=sanitizeColor(data.color);
    modal.showModal();
  }
  function buildCard(id) {
    var c=document.createElement('details');
    c.className='rule';c.setAttribute('data-fe-id',id);
    c.setAttribute('data-fe-created','true');
    c.innerHTML = '<summary><span class="seq"></span><span class="main"><span class="rname"></span>'
       + '<span class="rfoot"><span class="kind task">☷ Задача</span><span class="id">ID '+esc(id)+'</span></span></span><span class="chev">⌄</span></summary>'
       + '<div class="details"><a class="link" href="https://j50552.fitbase.io/AutomaticAction/automatic/update?id='+esc(id)+'" target="_blank" rel="noopener noreferrer">Открыть в Fitbase ↗</a></div>';
    return c;
  }
  function locationElement(value) {
    if(value==='Г') return q('.view[data-view="Г"] .globals');
    var stage=stageById(value);
    return stage?q('.stack',stage):null;
  }
  function applyCard(id,data) {
    if(!data || typeof data!=='object')return;
    var card=cardById(id)||buildCard(id);
    var loc=(/^Г\s*[-–]/i.test(data.code||''))?'Г':(data.stage||'Г');
    var destination=locationElement(loc)||locationElement('Г');
    if(!destination)return;
    destination.appendChild(card);
    q('.seq',card).textContent=String(data.code||'Общее');
    q('.rname',card).textContent=String(data.title||'Без названия');
    var type=TYPES.includes(data.kind)?data.kind:'Задача';
    card.setAttribute('data-kind',type);
    var isCall=type==='Задача'&&(typeof data.isCall==='boolean'?data.isCall:card.classList.contains('staff-call'));
    card.classList.toggle('staff-task',type==='Задача');
    card.classList.toggle('staff-call',isCall);
    card.setAttribute('data-activity',type==='Задача'?(isCall?'call':'task'):'');
    var badge=q('.kind',card);
    if(badge){badge.className='kind '+(isCall?'phone':STYLES[type][0]);badge.textContent=isCall?'☎ Звонок':STYLES[type][1]+' '+type;}
    if(data.created)card.setAttribute('data-fe-created','true');
    var fields=Array.isArray(data.fields)?data.fields:[];
    if(type==='Воронка')fields=fields.filter(function(f){return !f||!isFunnelOnlyTextField(f.label);});
    var html=fields.filter(function(f){return f && String(f.label||'').trim()}).map(function (f){
      var val=String(f.value||'');
      return '<div class="field"><div class="key">'+esc(f.label)+'</div>'
       + (f.body?'<div class="bodytext">'+esc(val)+'</div>':'<div class="fe-edit-value">'+esc(val)+'</div>')+'</div>';
    }).join('');
    var notes=String(data.notes||'').trim();
    if(notes)html+=notes.split(/\n\s*\n/).map(function (n){return '<div class="warn">'+esc(n)+'</div>';}).join('');
    html+='<a class="link" href="https://j50552.fitbase.io/AutomaticAction/automatic/update?id='+esc(id)+'" target="_blank" rel="noopener noreferrer">Открыть в Fitbase ↗</a>';
    var details=q('.details',card);
    if(details)details.innerHTML=html;
    var search=[id,data.code,data.title,type,notes].concat(fields.map(function(f){return f.label+' '+f.value;})).join(' ').toLowerCase();
    card.setAttribute('data-search',search);
    addEditButtons();
  }
  function applyStage(id,data) {
    var stage=stageById(id);
    if(!stage||!data)return;
    if(typeof data.title==='string')q('.stname',stage).textContent=data.title;
    if(typeof data.goal==='string')q('.objective',stage).innerHTML='<b>Цель:</b> '+esc(data.goal);
    if(typeof data.duty==='string')q('.duty',stage).innerHTML='<b>Задача:</b> '+esc(data.duty);
    if(typeof data.color==='string')stage.style.setProperty('--sc',sanitizeColor(data.color));
  }
  function sortValue(card) {
    var str=q('.seq',card)?.textContent||'';
    var g=str.match(/^Г\s*[-–]\s*(\d+)/i);
    if(g)return [9,+g[1],0,''];
    var m=str.match(/^(\d+)\.(\d+)(?:\.(\d+))?([a-zа-я])?/i);
    return m?[+m[1],+m[2],+(m[3]||0),m[4]||'']:[99,99,99,str];
  }
  function sortStacks() {
    all('.stage .stack,.globals').forEach(function (el){
      var cards=all(':scope > details.rule',el);
      cards.sort(function(a,b){
        var x=sortValue(a),y=sortValue(b);
        for(var i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];
        return String(x[3]).localeCompare(String(y[3]),'ru');
      });
      cards.forEach(function(c){el.appendChild(c);});
    });
  }
  function countCards() {
    all('.stage').forEach(function(s){
      var n=all(':scope > .stack > details.rule',s).length;
      var e=q('.count',s);if(e)e.textContent=n+' автодействий';
    });
    all('#nav [data-tab]').forEach(function(btn){
      var v=q('.view[data-view="'+btn.getAttribute('data-tab')+'"]');
      var n=v?all('details.rule',v).length:0;
      var sm=q('small',btn);if(sm)sm.textContent=String(n);
    });
    var search=q('#query');
    if(search)search.dispatchEvent(new Event('input',{bubbles:true}));
  }
  function applyAll() {
    Object.keys(source.stages).forEach(function(id){applyStage(id,source.stages[id]);});
    Object.keys(source.cards).forEach(function(id){applyCard(id,source.cards[id]);});
    Object.keys(draft.stages).forEach(function(id){applyStage(id,draft.stages[id]);});
    Object.keys(draft.cards).forEach(function(id){applyCard(id,draft.cards[id]);});
    sortStacks();all('details.rule').forEach(tidyCardDetails);all('details.rule').forEach(updateDisabledMarker);all('details.rule.staff-task').forEach(setTaskPriorityMarker);addEditButtons();countCards();updateStatus();
  }
  function onSubmit(e) {
    e.preventDefault();
    if(mode==='stage'){
      var data={id:editingId,title:q('#fe-stage-title').value.trim(),goal:q('#fe-goal').value.trim(),
        duty:q('#fe-duty').value.trim(),color:sanitizeColor(q('#fe-color').value)};
      if(!data.title){alert('Укажите название этапа.');return;}
      draft.stages[editingId]=data;
    }else{
      var id=editingId||q('#fe-id').value.trim();
      if(!/^\d+$/.test(id)||+id<1){alert('Укажите числовой ID автодействия в Fitbase.');return;}
      if(!editingId&&cardById(id)){alert('Карточка с таким ID уже существует. Откройте её для редактирования.');return;}
      var code=q('#fe-code').value.trim(),title=q('#fe-card-title').value.trim();
      if(!title||!code){alert('Укажите номер и название карточки.');return;}
      var dest=q('#fe-location').value;
      if(/^Г\s*[-–]/i.test(code))dest='Г';
      var fields=all('.fe-fieldrow',q('#fe-fields')).map(function(r){
        return {label:q('.fe-field-label',r).value.trim(),value:q('.fe-field-value',r).value,
          body:q('.fe-field-body',r).checked};
      }).filter(function(f){return f.label && (q('#fe-type').value!=='Воронка'||!isFunnelOnlyTextField(f.label));});
      draft.cards[id]={id:id,code:code,title:title,kind:q('#fe-type').value,isCall:q('#fe-type').value==='Задача'&&q('#fe-call').checked,stage:dest,
        fields:fields,notes:q('#fe-notes').value.trim(),created:!editingId || (cardById(id)?.getAttribute('data-fe-created')==='true')};
    }
    if(!saveDraft())return;
    applyAll();
    modal.close();
    toast('Сохранено в вашем браузере. Для публикации скачайте сайт HTML.');
  }
  function download(name,body,type) {
    var blob=new Blob([body],{type:type});
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a');
    a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
    setTimeout(function(){URL.revokeObjectURL(url);},1500);
  }
  function exportJSON() {
    var data=Object.assign({format:FORMAT,exportedAt:new Date().toISOString()},merged());
    download('fortis_staff_changes.json',JSON.stringify(data,null,2),'application/json;charset=utf-8');
    toast('Резервная копия JSON скачана.');
  }
  function generateHTML() {
    var full=merged();
    var clone=document.documentElement.cloneNode(true);
    all('#fe-toolbar,.fe-hint,#fe-dialog,.fe-flash,.fe-edit-card,.fe-edit-stage',clone).forEach(function(n){n.remove();});
    clone.classList.remove('fe-on');clone.querySelector('body')?.classList.remove('fe-on');
    all('.view',clone).forEach(function(v){v.hidden=v.getAttribute('data-view')!=='1';});
    all('details.rule',clone).forEach(function(c){c.hidden=false;c.open=false;});
    all('#nav button[data-tab]',clone).forEach(function(b){b.classList.toggle('active',b.getAttribute('data-tab')==='1');});
    var publish=clone.querySelector('#fortis-editor-published');
    if(!publish){
      publish=document.createElement('script');
      publish.id='fortis-editor-published';publish.type='application/json';
      clone.querySelector('body')?.appendChild(publish);
    }
    publish.textContent=safeJSON(full);
    var info=clone.querySelector('#info');
    if(info)info.textContent='Этапы CRM расположены горизонтально. Нажмите на карточку для подробностей.';
    return '<!doctype html>\n'+clone.outerHTML;
  }
  function exportHTML() {
    download('staff.html',generateHTML(),'text/html;charset=utf-8');
    toast('Скачан staff.html. Если автоматическая публикация недоступна, замените файл в GitHub вручную.');
  }
  async function publishChanges() {
    if(modal && modal.open) {
      alert('Сначала сохраните изменения открытой карточки.');
      return;
    }
    var password=window.prompt('Пароль администратора Фортис для публикации на сайте:');
    if(password===null)return;
    if(!password){alert('Пароль не указан.');return;}
    var html=generateHTML();
    if(!confirm('Опубликовать все текущие изменения сайта для сотрудников?\n\nИзменения в Fitbase НЕ вносятся.'))return;
    var button=q('[data-fe-action="publish"]');
    if(button){button.disabled=true;button.textContent='Публикация…';}
    try {
      var response=await fetch(ADMIN_API+'/api/publish',{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+password},
        body:JSON.stringify({html:html})
      });
      var result={};
      try{result=await response.json();}catch(e){}
      if(!response.ok)throw new Error(result.error||('Сервер ответил '+response.status));
      if(!result.ok)throw new Error('Сервер не подтвердил сохранение.');
      toast('Опубликовано в GitHub. Обновление сайта запускается автоматически.');
      var el=q('#fe-status');
      if(el)el.innerHTML='<strong>Сохранено и отправлено на публикацию.</strong> Render обновляет сайт. Черновик сохранён в браузере как резервная копия.';
    } catch (e) {
      var message=e&&e.message?e.message:'Ошибка сети.';
      alert('Не удалось опубликовать: '+message+'\n\nЧерновик остался у вас в браузере. Можно скачать HTML для ручной публикации.');
      toast('Ошибка публикации. Локальные изменения сохранены.');
    } finally {
      password='';
      if(button){button.disabled=false;button.textContent='✓ Сохранить и опубликовать';}
    }
  }
    async function importJSON(event) {
    var file=event.target.files&&event.target.files[0];
    event.target.value='';
    if(!file)return;
    if(file.size>3*1024*1024){alert('Файл слишком большой: максимум 3 МБ.');return;}
    try {
      var value=JSON.parse(await file.text());
      if(value.format!==FORMAT||!validState(value))throw Error('Неподдерживаемый формат резервной копии Fortis.');
      if(Object.keys(value.cards).length>700||Object.keys(value.stages).length>70)throw Error('Слишком много карточек или этапов.');
      if(!confirm('Импорт заменит текущий локальный черновик. Продолжить?'))return;
      draft={cards:value.cards,stages:value.stages};
      if(!saveDraft())return;
      location.reload();
    }catch(e){alert('Не удалось импортировать изменения: '+e.message);}
  }
  function resetDraft() {
    if(!confirm('Удалить только локальные изменения этого браузера? Опубликованные правки останутся на сайте.'))return;
    localStorage.removeItem(STORAGE);location.reload();
  }
  function wire() {
    document.addEventListener('click',function(e){
      var btn=e.target.closest('button[data-fe-action]');
      if(btn){
        var key=btn.getAttribute('data-fe-action');
        if(key==='toggle')setEditing(!editing);
        else if(key==='new-card'){setEditing(true);openCard(null,true);}
        else if(key==='close')modal.close();
        else if(key==='add-field')addFieldRow();
        else if(key==='remove-field'){btn.closest('.fe-fieldrow')?.remove();}
        else if(key==='export-json')exportJSON();
        else if(key==='import-json')q('#fe-file').click();
        else if(key==='export-html')exportHTML();
        else if(key==='publish')publishChanges();
        else if(key==='reset')resetDraft();
        return;
      }
      var cardBtn=e.target.closest('.fe-edit-card');
      if(cardBtn){e.preventDefault();e.stopPropagation();openCard(cardBtn.closest('details.rule'),false);return;}
      var stageBtn=e.target.closest('.fe-edit-stage');
      if(stageBtn){e.preventDefault();e.stopPropagation();openStage(stageBtn.closest('.stage'));return;}
    });
    q('#fe-type').addEventListener('change',function(){
      q('#fe-call-row').hidden=this.value!=='Задача';
      if(this.value!=='Задача')q('#fe-call').checked=false;
    });
    q('#fe-code').addEventListener('input',function(){
      if(/^Г\s*[-–]/i.test(this.value))q('#fe-location').value='Г';
    });
  }
  function start(){
    all('.stage').forEach(function (s){
      var n=q('.snum',s);
      if(n)s.setAttribute('data-fe-stage',n.textContent.replace(/^ЭТАП\s*/,'').trim());
    });
    var script=q('#fortis-editor-published');
    if(script){try{var x=JSON.parse(script.textContent);if(validState(x))source=x;}catch(e){console.warn('Fortis published edits:',e.message);}}
    try{var raw=JSON.parse(localStorage.getItem(STORAGE)||'null');if(validState(raw))draft=raw;}catch(e){console.warn('Fortis local edits:',e.message);}
    editorUI();addEditButtons();wire();applyAll();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);
  else start();
})();