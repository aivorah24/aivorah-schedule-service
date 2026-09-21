/**
 * Shared grades/sections merge logic — extracted from routes/school-admin.js
 * so it can also be used by routes/classes.js (which must be callable by
 * student/parent/teacher, not just admins; school-admin.js's router-level
 * requireAdminScope middleware would 403 those roles).
 *
 * Student data (users.grade / users.section) is the source of truth for what
 * exists and the live counts; schools.academic_structure is a thin overlay
 * persisting structure students don't imply yet (empty sections, freshly
 * added grades) and archive intent, plus per-section classTeacherEmail. The
 * two are MERGED on read.
 * Overlay shape: { grades: [{ name, archived, sections: [{ name, archived, classTeacherEmail }] }] }
 */
const supabase = require('./supabase');

// Natural sort so "Grade 2" comes before "Grade 10" (plain string sort puts
// "Grade 10" first). Falls back to locale compare for non-numeric names.
//
// Grade LABELS are curriculum-specific free text — never a hardcoded Grade
// 1-12 range (a school may use "Stage 4", "PYP 3", "MYP 2", "DP 1", "IGCSE",
// etc; see resolveCurriculum in routes/school-admin.js for how IB spans
// PYP/MYP/DP within one school). Pure digit-extraction alone gets same-family
// labels right (Stage 1..Stage 12, Grade 1..Grade 12) but would incorrectly
// interleave a multi-track curriculum by number alone (e.g. "MYP 1" sorting
// before "PYP 5", when the programs themselves have a fixed pedagogical
// sequence). PROGRAM_TIER encodes just that known sequence as a tie-break —
// it does NOT enumerate grades, so any grade count/label within a program
// still sorts purely by its own number.
const PROGRAM_TIER = { PYP: 0, MYP: 1, DP: 2 };

function gradeSortKey(name) {
  const n = parseInt(String(name).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function gradeProgramTier(name) {
  const m = String(name || '').trim().match(/^([A-Za-z]+)/);
  const prefix = m ? m[1].toUpperCase() : '';
  return Object.prototype.hasOwnProperty.call(PROGRAM_TIER, prefix) ? PROGRAM_TIER[prefix] : null;
}

function sortGradeNames(a, b) {
  const ta = gradeProgramTier(a), tb = gradeProgramTier(b);
  if (ta !== null && tb !== null && ta !== tb) return ta - tb; // PYP block, then MYP block, then DP block
  const ka = gradeSortKey(a), kb = gradeSortKey(b);
  if (ka !== kb) return ka - kb; // numeric within the same family/program (or both non-IB, e.g. "Grade N", "Stage N")
  return String(a).localeCompare(String(b)); // stable fallback (e.g. "IGCSE" vs a numberless label)
}

// Distinct from sortGradeNames: this sorts the CURRICULUM column itself
// ("IB PYP", "IB MYP", "IB DP", "CBSE", "ICSE", "Cambridge", ...), not the
// grade label. "IB PYP" < "IB DP" alphabetically, which is the wrong
// pedagogical order — so IB's fixed PYP→MYP→DP sequence is the only
// hardcoded ordering here; every other curriculum name just sorts
// alphabetically after the IB entries.
const CURRICULUM_ORDER = ['IB PYP', 'IB MYP', 'IB DP'];
function sortCurriculumNames(a, b) {
  const ia = CURRICULUM_ORDER.indexOf(a), ib = CURRICULUM_ORDER.indexOf(b);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return String(a).localeCompare(String(b));
}

function emptyStructure() { return { grades: [] }; }

// Merge the persisted overlay with the grades/sections students actually use,
// attaching a live student count to each section (and an implicit blank
// section bucket when a student has a grade but no section).
async function buildGradesSectionsView(schoolId) {
  const { data: school } = await supabase.from('schools').select('academic_structure').eq('id', schoolId).maybeSingle();
  const overlay = (school && school.academic_structure && typeof school.academic_structure === 'object')
    ? school.academic_structure : emptyStructure();
  const overlayGrades = Array.isArray(overlay.grades) ? overlay.grades : [];

  const { data: students } = await supabase
    .from('users').select('grade, section').eq('school_id', schoolId).eq('role', 'student').neq('status', 'archived');

  // grade -> Map(sectionName -> count).  '' section = "unassigned" bucket.
  const counts = new Map();
  for (const s of students || []) {
    const g = String(s.grade || '').trim();
    if (!g) continue;
    const sec = String(s.section || '').trim();
    if (!counts.has(g)) counts.set(g, new Map());
    const secMap = counts.get(g);
    secMap.set(sec, (secMap.get(sec) || 0) + 1);
  }

  // Start from overlay, then fold in any student grade/section not present.
  const byGrade = new Map(); // name -> { name, archived, sections: Map(name -> {archived, classTeacherEmail}) }
  for (const g of overlayGrades) {
    const name = String(g.name || '').trim();
    if (!name) continue;
    const secMap = new Map();
    for (const sec of Array.isArray(g.sections) ? g.sections : []) {
      const sname = String(sec.name || '').trim();
      if (sname) secMap.set(sname, { archived: !!sec.archived, classTeacherEmail: sec.classTeacherEmail || null });
    }
    byGrade.set(name, { name, archived: !!g.archived, sections: secMap });
  }
  for (const [g, secMap] of counts) {
    if (!byGrade.has(g)) byGrade.set(g, { name: g, archived: false, sections: new Map() });
    const entry = byGrade.get(g);
    for (const sec of secMap.keys()) {
      if (sec && !entry.sections.has(sec)) entry.sections.set(sec, { archived: false, classTeacherEmail: null });
    }
  }

  const grades = [...byGrade.values()].map((entry) => {
    const secMap = counts.get(entry.name) || new Map();
    const sections = [...entry.sections.entries()].map(([name, meta]) => ({
      name, archived: !!meta.archived, studentCount: secMap.get(name) || 0, classTeacherEmail: meta.classTeacherEmail || null,
    })).sort((a, b) => a.name.localeCompare(b.name));
    const unassigned = secMap.get('') || 0;
    const totalStudents = [...secMap.values()].reduce((a, b) => a + b, 0);
    return { name: entry.name, archived: entry.archived, sections, unassignedCount: unassigned, totalStudents };
  }).sort((a, b) => sortGradeNames(a.name, b.name));

  return grades;
}

// Persist the merged structure back to the overlay so future edits (rename /
// archive / add) operate on a stable, fully-materialised list.
async function saveStructure(schoolId, grades) {
  const structure = {
    grades: grades.map((g) => ({
      name: g.name,
      archived: !!g.archived,
      sections: (g.sections || []).map((s) => ({ name: s.name, archived: !!s.archived, classTeacherEmail: s.classTeacherEmail || null })),
    })),
  };
  const { error } = await supabase.from('schools').update({ academic_structure: structure }).eq('id', schoolId);
  if (error) throw error;
}

module.exports = { gradeSortKey, sortGradeNames, sortCurriculumNames, emptyStructure, buildGradesSectionsView, saveStructure };
