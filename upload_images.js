const { supabase } = require('./services/database');
const fs = require('fs');
const path = require('path');

const imgDir = '/Users/dikenson/.gemini/antigravity/brain/39570602-3860-48e8-b65d-3448f074b4c8/';
const files = {
  white: 'white_crystals_luxury_1775409179869.png',
  green: 'green_herbs_premium_1775409194686.png',
  pink: 'pink_powder_aesthetic_shot_1775409209093.png',
  pills: 'colorful_geometric_pills_premium_1775409223103.png'
};

const mapping = {
  'Ketamine': 'white',
  'Weed cali': 'green',
  'MDMA': 'pills',
  'Mousseux/ filtre/ frozen': 'green',
  'Tuci': 'pink',
  'Coco': 'white',
  'Weed': 'green',
  'Extasy': 'pills',
  '3mmc': 'white',
  'test 4': 'pills',
  'Mousseux': 'green'
};

async function run() {
  try {
    const urls = {};
    for (const [key, filename] of Object.entries(files)) {
      const filePath = path.join(imgDir, filename);
      const fileBuf = fs.readFileSync(filePath);
      const ext = '.png';
      const storageName = `demo-${key}-${Date.now()}${ext}`;

      console.log(`Uploading ${key}...`);
      const { error: uploadError } = await supabase.storage
        .from('uploads')
        .upload(storageName, fileBuf, { contentType: 'image/png', upsert: true });

      if (uploadError) {
        console.error(`Upload error for ${key}:`, uploadError.message);
        continue;
      }

      const { data: { publicUrl } } = supabase.storage.from('uploads').getPublicUrl(storageName);
      urls[key] = publicUrl;
      console.log(`URL for ${key}: ${publicUrl}`);
    }

    console.log('Updating database...');
    const { data: products, error: fetchError } = await supabase.from('bot_products').select('id, name');
    if (fetchError) throw fetchError;

    for (const p of products) {
      const type = mapping[p.name.trim()];
      if (type && urls[type]) {
        console.log(`Updating ${p.name} with ${urls[type]}`);
        const { error: updateError } = await supabase.from('bot_products')
          .update({ image_url: JSON.stringify([{ url: urls[type], type: 'photo' }]) })
          .eq('id', p.id);
        if (updateError) console.error(`Error updating ${p.name}:`, updateError.message);
      }
    }

    console.log('Done!');
  } catch (err) {
    console.error('Fatal:', err);
  }
}

run();
