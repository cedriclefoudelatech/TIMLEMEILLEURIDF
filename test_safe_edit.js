const { safeEdit } = require('./services/utils');
const { Markup } = require('telegraf');

const callbackMessage = {
  message_id: 123,
  text: 'Menu principal',
  photo: null,
  video: null
};

let editCalled = false;
let replyCalled = false;
let replyPhotoCalled = false;

const mockCtx = {
  platform: 'telegram',
  chat: { id: '987654321', type: 'private' },
  from: { id: '987654321' },
  _handled: false,
  callbackQuery: { data: 'main_menu', message: callbackMessage },
  message: { text: 'main_menu', message_id: undefined },
  state: { settings: {}, user: {} },
  telegram: {
    editMessageText: async (chatId, msgId, inlineMsgId, text, extra) => {
      editCalled = true;
      console.log('[editMessageText] chatId:', chatId, 'msgId:', msgId, 'hasKeyboard:', !!(extra && extra.reply_markup));
      return { message_id: 123 };
    },
    editMessageMedia: async (...args) => {
      console.log('[editMessageMedia] called');
    },
    deleteMessage: async (cid, mid) => {
      console.log('[deleteMessage] cid:', cid, 'mid:', mid);
    }
  },
  reply: async (text, extra) => {
    replyCalled = true;
    const hasKb = !!(extra && (extra.reply_markup || extra.inline_keyboard));
    console.log('[reply/new msg] text:', text.substring(0,30), '| hasKeyboard:', hasKb);
    return { message_id: 999, messageId: 999 };
  },
  replyWithHTML: async (text, extra) => {
    console.log('[replyWithHTML]');
    return mockCtx.reply(text, extra);
  },
  replyWithPhoto: async (photo, extra) => {
    replyPhotoCalled = true;
    console.log('[replyWithPhoto] photo:', String(photo).substring(0,50));
    return { message_id: 888, messageId: 888 };
  },
  replyWithVideo: async (video, extra) => {
    console.log('[replyWithVideo] video:', String(video).substring(0,50));
    return { message_id: 777, messageId: 777 };
  },
  channel: { type: 'telegram' },
  answerCbQuery: async () => {}
};

async function test() {
  console.log('=== Test 1: text->text edit ===');
  editCalled = false; replyCalled = false;
  try {
    await safeEdit(mockCtx, 'Menu principal', Markup.inlineKeyboard([[Markup.button.callback('Catalogue', 'view_catalog')]]));
    console.log('Result: editCalled=', editCalled, '| replyCalled=', replyCalled);
  } catch(e) {
    console.error('ERROR:', e.message);
  }
  
  console.log('\n=== Test 2: photo->text (should send new text msg) ===');
  editCalled = false; replyCalled = false; replyPhotoCalled = false;
  mockCtx.callbackQuery.message = { message_id: 456, photo: [{file_id: 'abc'}], text: undefined };
  try {
    await safeEdit(mockCtx, 'Catalogue', Markup.inlineKeyboard([[Markup.button.callback('Retour', 'main_menu')]]));
    console.log('Result: editCalled=', editCalled, '| replyCalled=', replyCalled, '| replyPhotoCalled=', replyPhotoCalled);
  } catch(e) {
    console.error('ERROR:', e.message);
  }
  
  console.log('\n=== Test 3: no callbackQuery (text message) ===');
  editCalled = false; replyCalled = false;
  mockCtx.callbackQuery = null;
  try {
    await safeEdit(mockCtx, 'Menu', Markup.inlineKeyboard([[Markup.button.callback('Retour', 'main_menu')]]));
    console.log('Result: editCalled=', editCalled, '| replyCalled=', replyCalled);
  } catch(e) {
    console.error('ERROR:', e.message);
  }
}

test().then(() => { process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
