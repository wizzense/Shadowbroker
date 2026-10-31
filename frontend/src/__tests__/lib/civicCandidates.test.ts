import { describe, expect, it } from 'vitest';
import {
  ballotpediaUrl,
  candidateAgentPrompt,
  CANDIDATE_ID,
  fecCommitteeWebsite,
  fecCycleFor,
  fecDisplayName,
  fecOfficeFor,
  federalCandidatesUrl,
  normalizeCampaignUrl,
  parseFederalQuery,
  shapeFecCandidates,
  shapeGoogleVoterInfo,
  voteSmartSearchUrl,
} from '@/lib/civicCandidates';

// Rows trimmed from https://api.open.fec.gov/v1/candidates/totals/?state=OH&office=H&district=01&cycle=2026 (2026-10-30).
const FEC_TOTALS = {
  results: [
    {
      candidate_id: 'H6OH01195', name: 'ADAMS, HOLLY', party: 'REP', party_full: 'REPUBLICAN PARTY',
      incumbent_challenge: 'C', incumbent_challenge_full: 'Challenger', office: 'H', office_full: 'House',
      state: 'OH', district: '01', receipts: 412794.06, disbursements: 412794.06,
      cash_on_hand_end_period: '0.00', coverage_end_date: '2026-06-22',
    },
    {
      candidate_id: 'H2OH01194', name: 'LANDSMAN, GREG', party: 'DEM', party_full: 'DEMOCRATIC PARTY',
      incumbent_challenge: 'I', office: 'H', state: 'OH', district: '01', receipts: 3100000,
      disbursements: 1500000, cash_on_hand_end_period: 1900000.5, coverage_end_date: '2026-09-30T00:00:00',
    },
    { candidate_id: 'H2OH01194', name: 'LANDSMAN, GREG', receipts: 1 }, // duplicate cycle row
    { candidate_id: 'not-an-id', name: 'X' },
  ],
};

describe('FEC shaping', () => {
  it('turns FEC rows into candidates, richest first, deduplicated', () => {
    const list = shapeFecCandidates(FEC_TOTALS, 2026);
    expect(list.map((c) => c.id)).toEqual(['fec:H2OH01194', 'fec:H6OH01195']);
    const [greg, holly] = list;
    expect(greg).toMatchObject({
      name: 'Greg Landsman', party: 'DEMOCRATIC PARTY', status: 'Incumbent', office: 'U.S. House',
      state: 'OH', district: '1', cycle: 2026, source: 'fec', has_campaign_site: false,
    });
    expect(greg.money).toEqual({ receipts: 3100000, disbursements: 1500000, cash_on_hand: 1900000.5, coverage_end: '2026-09-30T00:00:00' });
    expect(holly.status).toBe('Challenger');
    expect(holly.money?.cash_on_hand).toBe(0);
    const links = Object.fromEntries(greg.links.map((l) => [l.kind, l]));
    expect(links.fec.url).toBe('https://www.fec.gov/data/candidate/H2OH01194/');
    expect(links.ballotpedia).toMatchObject({ url: 'https://ballotpedia.org/Greg_Landsman', search: true });
    expect(links.votesmart.search).toBe(true);
  });

  it('tolerates junk', () => {
    expect(shapeFecCandidates(null, 2026)).toEqual([]);
    expect(shapeFecCandidates({ results: 'x' }, 2026)).toEqual([]);
  });

  it('formats FEC names', () => {
    expect(fecDisplayName('ADAMS, HOLLY')).toBe('Holly Adams');
    expect(fecDisplayName('MCCARTHY, KEVIN O. JR.')).toBe('Kevin O. McCarthy Jr.');
    expect(fecDisplayName("O'ROURKE, ROBERT MR. III")).toBe("Robert O'Rourke III");
    expect(fecDisplayName('SMITH-JONES, ANNA')).toBe('Anna Smith-Jones');
  });

  it('reads the principal committee website and normalises it to https', () => {
    expect(fecCommitteeWebsite({ results: [{ designation: 'P', website: 'HOLLYADAMSFORCONGRESS.COM' }] }))
      .toBe('https://hollyadamsforcongress.com/');
    expect(fecCommitteeWebsite({ results: [{ designation: 'P', website: 'HTTPS://LANDSMANFORCONGRESS.COM/' }] }))
      .toBe('https://landsmanforcongress.com/');
    expect(fecCommitteeWebsite({ results: [{ designation: 'P', website: null }] })).toBeNull();
    expect(normalizeCampaignUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeCampaignUrl('http://example.org/issues')).toBe('https://example.org/issues');
    expect(normalizeCampaignUrl('localhost')).toBeNull();
  });

  it('maps elections to FEC races', () => {
    expect(fecOfficeFor('U.S. House')).toBe('H');
    expect(fecOfficeFor('U.S. Senate')).toBe('S');
    expect(fecOfficeFor('Governor')).toBeNull();
    expect(fecCycleFor('2026-11-03')).toBe(2026);
    expect(fecCycleFor('2027-11-02')).toBe(2028);
    expect(fecCycleFor('')).toBeNull();
    expect(federalCandidatesUrl('OH', 'H', '1', 2026)).toBe('/api/civic-candidates/federal?state=OH&office=H&district=01&cycle=2026');
    expect(federalCandidatesUrl('OH', 'S', '1', 2026)).toBe('/api/civic-candidates/federal?state=OH&office=S&cycle=2026');
  });

  it('validates the federal query', () => {
    expect(parseFederalQuery(new URLSearchParams('state=oh&office=h&district=1&cycle=2026'))).toEqual({
      ok: true, state: 'OH', office: 'H', district: '01', cycle: 2026,
    });
    expect(parseFederalQuery(new URLSearchParams('state=ZZ&office=H')).ok).toBe(false);
    expect(parseFederalQuery(new URLSearchParams('state=OH&office=G')).ok).toBe(false);
    expect(parseFederalQuery(new URLSearchParams('state=OH&office=H&district=at-large')).ok).toBe(false);
    expect(parseFederalQuery(new URLSearchParams('state=OH&office=H&cycle=2025')).ok).toBe(false);
    expect(parseFederalQuery(new URLSearchParams('state=OH&office=S&district=4'))).toMatchObject({ ok: true, district: '' });
  });
});

describe('Google Civic voterinfo shaping', () => {
  it('keeps candidate contests, issues server ids, builds channel links, never trusts URLs blindly', () => {
    const issued: string[] = [];
    const out = shapeGoogleVoterInfo(
      {
        election: { name: 'General', electionDay: '2026-11-03' },
        contests: [
          { type: 'Referendum', referendumTitle: 'Issue 1' },
          {
            office: 'Mayor', level: ['locality'], district: { name: 'Cincinnati' },
            candidates: [
              {
                name: 'Jane Doe', party: 'Nonpartisan', candidateUrl: 'janedoe.org', photoUrl: 'javascript:x',
                channels: [{ type: 'Twitter', id: '@janedoe' }, { type: 'Facebook', id: 'janedoe' }],
              },
            ],
          },
        ],
      },
      (c) => {
        issued.push(c.url ?? '');
        return 'gc:0123456789abcdef';
      },
    );
    expect(out.election).toEqual({ name: 'General', day: '2026-11-03' });
    expect(out.contests).toHaveLength(1);
    const c = out.contests[0].candidates[0];
    expect(c).toMatchObject({ id: 'gc:0123456789abcdef', has_campaign_site: true, photo_url: '', source: 'google' });
    expect(issued).toEqual(['https://janedoe.org/']);
    expect(c.links.map((l) => l.url)).toEqual(expect.arrayContaining(['https://janedoe.org/', 'https://x.com/janedoe', 'https://www.facebook.com/janedoe']));
  });
});

describe('links and prompts', () => {
  it('Ballotpedia and Vote Smart are name searches, labelled as such', () => {
    expect(ballotpediaUrl('Mary Ann Smith')).toBe('https://ballotpedia.org/Mary_Ann_Smith');
    expect(voteSmartSearchUrl('Mary Ann Smith')).toBe('https://justfacts.votesmart.org/search?search=Mary+Ann+Smith');
  });

  it('the agent prompt names the candidate, asks for citations and the tool to use', () => {
    const p = candidateAgentPrompt({ id: 'fec:H2OH01194', name: 'Greg Landsman', office: 'U.S. House', state: 'OH', district: '1' });
    expect(p).toMatch(/^Summarize Greg Landsman's platform and policy positions \(U\.S\. House OH district 1\) from their campaign site; cite it\./);
    expect(p).toContain('get_candidate_page');
    expect(CANDIDATE_ID.test('fec:H2OH01194')).toBe(true);
    expect(CANDIDATE_ID.test('https://evil.example')).toBe(false);
  });
});
