#!/usr/bin/env node
/**
 * One-time migration: data/*.json + assets/images -> Supabase.
 *
 * Usage:
 *   cp .env.example .env.local   # fill in URL + SERVICE_ROLE_KEY
 *   npm install
 *   npm run migrate:data
 *
 * Safe to re-run: students and events are matched by slug and updated.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const root = process.cwd();
const eventsPath = path.join(root, 'data/events.json');
const studentsPath = path.join(root, 'data/students.json');
const imagesDir = path.join(root, 'assets/images');

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_MEDIA_BUCKET || 'media';

if (!url || !serviceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env.local first.');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const eventsJson = readJson(eventsPath);
const studentsJson = readJson(studentsPath);
const eventList = eventsJson.events || [];
const studentList = studentsJson.students || [];
const topList = studentsJson.topStudents || [];
const topMap = new Map(topList.map((item) => [item.name, item.role]));

const slugify = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const normalizeName = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const stripHtml = (value) =>
  String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const truncate = (value, length = 160) =>
  value.length > length ? `${value.slice(0, length - 1).trim()}…` : value;

const parseDateLabel = (label) => {
  const value = String(label || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const dmy = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, day, month, year] = dmy;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return null;
};

const imagePaths = new Set();
for (const student of studentList) {
  if (student.image?.startsWith('assets/images/')) imagePaths.add(student.image);
}
for (const event of eventList) {
  for (const element of event.elements || []) {
    if (element.type === 'image' && element.image?.startsWith('assets/images/')) {
      imagePaths.add(element.image);
    }
    if (element.type === 'slideshow') {
      for (const image of element.images || []) {
        if (image?.startsWith('assets/images/')) imagePaths.add(image);
      }
    }
  }
}

const contentType = (file) => {
  const ext = path.extname(file).toLowerCase();
  return {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml'
  }[ext] || 'application/octet-stream';
};

const safeStorageName = (file, index) => {
  const ext = path.extname(file);
  const base = path.basename(file, ext).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  return `${index}-${base}${ext}`;
};

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

const imageUrlByPath = new Map();

async function uploadImages() {
  const paths = [...imagePaths];
  console.log(`Uploading ${paths.length} referenced images to storage bucket "${bucket}"...`);

  await mapLimit(paths, 4, async (originalPath, index) => {
    const file = path.join(root, originalPath);
    if (!fs.existsSync(file)) {
      console.warn(`  missing image: ${originalPath}`);
      imageUrlByPath.set(originalPath, originalPath);
      return;
    }

    const storagePath = `legacy/${safeStorageName(originalPath, index)}`;
    const buffer = fs.readFileSync(file);
    const { error } = await supabase.storage.from(bucket).upload(storagePath, buffer, {
      contentType: contentType(file),
      upsert: true
    });

    if (error) {
      throw new Error(`upload failed for ${originalPath}: ${error.message}`);
    }

    const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
    imageUrlByPath.set(originalPath, data.publicUrl);
  });
}

const resolveImage = (value) => {
  if (!value) return '';
  return imageUrlByPath.get(value) || value;
};

const studentIdByName = new Map();
const studentSlugByName = new Map();

function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
}

function findStudentId(name) {
  const key = normalizeName(name);
  if (!key) return null;
  if (studentIdByName.has(key)) return studentIdByName.get(key);

  let best = null;
  let bestDistance = Infinity;
  for (const [candidate, id] of studentIdByName.entries()) {
    const distance = levenshtein(key, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { candidate, id };
    }
  }

  if (best && bestDistance <= 4) {
    console.warn(`  fuzzy match: "${name}" -> "${best.candidate}" (distance ${bestDistance})`);
    studentIdByName.set(key, best.id);
    return best.id;
  }

  return null;
}

async function createPlaceholderStudent(name) {
  const slug = slugify(name);
  console.log(`  creating placeholder student: ${name} (${slug})`);
  const { data, error } = await supabase.rpc('save_student', {
    p_student: {
      slug,
      name,
      role: '',
      quote: '',
      image_url: '',
      star: false,
      type: 'student',
      class_level: null,
      achievements: [],
      is_top: false,
      top_role: ''
    }
  });
  if (error) throw new Error(`placeholder student failed for ${name}: ${error.message}`);
  studentIdByName.set(normalizeName(name), data);
  studentSlugByName.set(normalizeName(name), slug);
  return data;
}

async function saveStudents() {
  console.log(`Saving ${studentList.length} students...`);
  for (let index = 0; index < studentList.length; index += 1) {
    const student = studentList[index];
    const slug = student.id || slugify(student.name);
    const payload = {
      slug,
      name: student.name,
      role: student.role || '',
      quote: student.quote || '',
      image_url: resolveImage(student.image),
      star: Boolean(student.star),
      type: student.type || 'student',
      class_level: student.type === 'teacher' ? null : student.class || null,
      achievements: student.achievements || [],
      is_top: topMap.has(student.name),
      top_role: topMap.get(student.name) || '',
      sort_order: index
    };
    const { data, error } = await supabase.rpc('save_student', { p_student: payload });
    if (error) throw new Error(`student failed for ${student.name}: ${error.message}`);
    studentIdByName.set(normalizeName(student.name), data);
    studentSlugByName.set(normalizeName(student.name), slug);
  }

  const { data, error } = await supabase.from('students').select('id, slug, name');
  if (error) throw new Error(`could not read students: ${error.message}`);
  for (const row of data || []) {
    studentIdByName.set(normalizeName(row.name), row.id);
    studentSlugByName.set(normalizeName(row.name), row.slug);
  }
}

function mapPeople(list, kind) {
  return (list || [])
    .filter((person) => person && person.name)
    .map((person) => {
      let id = findStudentId(person.name);
      return { person, id, kind };
    });
}

async function saveEvents() {
  console.log(`Saving ${eventList.length} events...`);

  for (let index = 0; index < eventList.length; index += 1) {
    const event = eventList[index];
    const elements = [];

    for (const element of event.elements || []) {
      if (element.type === 'students' || element.type === 'organizers') {
        const people = mapPeople(element[element.type], element.type);
        for (const entry of people) {
          if (!entry.id) {
            entry.id = await createPlaceholderStudent(entry.person.name);
          }
        }
        elements.push({
          type: element.type,
          data: {},
          people: people.map(({ person, id }) => ({
            student_id: id,
            name: person.name,
            role: person.role || '',
            achievement: person.achievement || ''
          }))
        });
        continue;
      }

      if (element.type === 'image') {
        elements.push({
          type: 'image',
          data: {
            image: resolveImage(element.image),
            align: element.align || 'full',
            caption: element.caption || ''
          }
        });
        continue;
      }

      if (element.type === 'slideshow') {
        elements.push({
          type: 'slideshow',
          data: {
            images: (element.images || []).map(resolveImage),
            caption: element.caption || ''
          }
        });
        continue;
      }

      if (element.type === 'video') {
        elements.push({ type: 'video', data: { video: element.video || '' } });
        continue;
      }

      if (element.type === 'quote') {
        elements.push({
          type: 'quote',
          data: { quote: element.quote || '', author: element.author || '' }
        });
        continue;
      }

      elements.push({ type: 'text', data: { content: element.content || '' } });
    }

    const firstImage = elements.find(
      (element) =>
        element.type === 'image' ||
        (element.type === 'slideshow' && element.data.images?.length)
    );
    const cover =
      firstImage?.type === 'image'
        ? firstImage.data.image
        : firstImage?.data?.images?.[0] || '';
    const excerpt = stripHtml(
      elements.find((element) => element.type === 'text')?.data?.content || ''
    );

    const payload = {
      slug: event.id || slugify(event.title),
      title: event.title,
      category: event.category || 'School',
      date_label: event.date || '',
      event_date: parseDateLabel(event.date),
      featured: Boolean(event.featured),
      status: 'published',
      sort_order: index,
      cover_image_url: cover,
      seo_title: `${event.title} | The Rising Times`,
      seo_description: truncate(excerpt),
      og_image_url: cover,
      elements
    };

    const { error } = await supabase.rpc('save_event', { p_event: payload });
    if (error) throw new Error(`event failed for ${event.title}: ${error.message}`);
  }
}

async function saveCouncil() {
  const council = eventsJson.cseCouncil;
  if (!council) return;

  const headId = findStudentId(council.head) || (await createPlaceholderStudent(council.head));
  const positions = [];

  for (const [stage, roles] of Object.entries(council.stages || {})) {
    for (const [role, name] of Object.entries(roles || {})) {
      if (!name) {
        positions.push({ stage, role, student_id: null });
        continue;
      }
      const id = findStudentId(name) || (await createPlaceholderStudent(name));
      positions.push({ stage, role, student_id: id });
    }
  }

  const { error } = await supabase.rpc('save_cse', {
    p_head_student_id: headId,
    p_positions: positions
  });
  if (error) throw new Error(`CSE council failed: ${error.message}`);
}

async function saveSettings() {
  const slugFor = (name) => studentSlugByName.get(normalizeName(name)) || slugify(name);
  const settings = {
    site: {
      name: 'The Rising Times',
      school: 'Rising Stars Language School',
      system: 'Futures Education System'
    },
    hero: {
      title: 'The Rising Times',
      subtitle: 'The Official Digital Magazine of Rising Stars Language School',
      readMore: 'Read News'
    },
    about: {
      text:
        'This website was conceived and built by the Cultural, Scientific & Educational Council (CSE) of Rising Stars Language School. This digital magazine is to showcase our school\'s achievements & all of our students\' perseverance to keep learning and getting better.',
      cta: 'Visit CSE Council'
    },
    school: {
      items: [
        'Private school owned by futures education system',
        'Modern school with smart boards and science labs',
        'Beautiful garden for student activities',
        'Committed to excellence and innovation'
      ]
    },
    social: {
      instagram: 'https://www.instagram.com/risingtimesofficial?igsh=MW5zdmk3dnA4OTVvbw==',
      facebook: 'https://www.facebook.com/RisingStars.6thofOctober/'
    },
    videos: {
      main: 'https://youtu.be/hDmSL2mo4b4?si=aifXbCBIoHW100_T',
      secondary: 'https://youtu.be/VBsYzKxRdEA?si=A5tMzBfgJcRrWr9L'
    },
    footer: {
      tagline:
        'The Rising Times is the premier source for Rising News and student achievements at Rising Stars Language School. Explore our digital magazine for the latest updates from Rising Stars.',
      copyright: '© 2026 All Rights Reserved'
    },
    seo: {
      title: 'The Rising Times | Rising Stars News & Language School Magazine',
      description:
        'Official school news magazine for Rising Stars Language School, The Rising Times. Featuring student achievements, academic competitions, and Rising Stars news updates.',
      keywords:
        'Rising Stars, School Magazine, The Rising Times, Student Achievements, CSE Council, Rising Stars News',
      ogImage: resolveImage('assets/images/logo1.png')
    },
    team: {
      slugs: [
        slugFor('Youssef Ahmed Sabry'),
        slugFor('Ahmed Alaadin Hassan Darmelli'),
        slugFor('Yassin Ahmed Sabry'),
        slugFor('Lily Ahmed'),
        slugFor('Ahmed Adel Abd Elhafeez')
      ]
    },
    student_priority: {
      slugs: [
        slugFor('Youssef Ahmed Sabry'),
        slugFor('Ahmed Alaadin Hassan Darmelli'),
        slugFor('Yassin Ahmed Sabry'),
        slugFor('Lily Ahmed'),
        slugFor('Ahmed Adel Abd Elhafeez')
      ]
    }
  };

  const { error } = await supabase.rpc('save_settings', { p_settings: settings });
  if (error) throw new Error(`settings failed: ${error.message}`);
}

async function report() {
  const [{ count: eventCount }, { count: studentCount }, { count: cseCount }] = await Promise.all([
    supabase.from('events').select('*', { count: 'exact', head: true }),
    supabase.from('students').select('*', { count: 'exact', head: true }),
    supabase.from('cse_positions').select('*', { count: 'exact', head: true })
  ]);

  const allImages = fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir) : [];
  const usedNames = new Set([...imagePaths].map((item) => path.basename(item)));
  const unused = allImages.filter((name) => !usedNames.has(name));
  const reportPath = path.join(root, 'scripts/unused-images.json');
  fs.writeFileSync(reportPath, JSON.stringify(unused, null, 2));

  console.log('\nMigration complete.');
  console.log(`  events: ${eventCount}`);
  console.log(`  students: ${studentCount}`);
  console.log(`  cse positions: ${cseCount}`);
  console.log(`  images uploaded: ${imageUrlByPath.size}`);
  console.log(`  unused images left in repo: ${unused.length} (list: scripts/unused-images.json)`);
}

async function main() {
  await uploadImages();
  await saveStudents();
  await saveEvents();
  await saveCouncil();
  await saveSettings();
  await report();
}

main().catch((error) => {
  console.error('\nMigration failed:', error.message);
  process.exit(1);
});
